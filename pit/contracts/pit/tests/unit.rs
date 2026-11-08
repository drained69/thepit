//! Host-side unit tests for `pit` (mocked blockchain env).
//! Run with: cargo test --features unit-tests
//!
//! Covers: curve buy/sell · fees → surplus · slippage · auto-registration ·
//! instant vs queued sells · stake / unstake / withdraw round-trip with mocked
//! pool responses · reward harvest to brain · lock + timeout · brain-only
//! rotation · tiers · solvency under a random trade sequence.

#![cfg(feature = "unit-tests")]

use pit::{ThePit, PoolAccount, Tier, LOCK_TIMEOUT_MS, ONE_NEAR, ONE_TOKEN, TICKET_DEPOSIT};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig};
use near_sdk::test_vm_config;

const ME: &str = "pit.near";
const BRAIN: &str = "brain.near";
const POOL: &str = "pool.near";
const ALICE: &str = "alice.near";
const BOB: &str = "bob.near";

const FEE_BPS: u16 = 100; // 1%
const BUFFER_BPS: u16 = 2_000; // 20%

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn near(n: u128) -> u128 {
    n * ONE_NEAR
}

fn ctx(predecessor: &str, now_ms: u64, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .signer_account_id(acc(predecessor))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(10_000_000))
        .attached_deposit(NearToken::from_yoctonear(deposit));
    b
}

fn env_as(predecessor: &str, now_ms: u64, deposit: u128) {
    testing_env!(ctx(predecessor, now_ms, deposit).build());
}

/// Callback context: called by ourselves, with one mocked promise result.
fn env_callback(now_ms: u64, ok: bool) {
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        ctx(ME, now_ms, 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

fn tiers() -> Vec<Tier> {
    vec![
        Tier { name: "Larva".into(), min_principal: U128(0) },
        Tier { name: "Juvenile".into(), min_principal: U128(near(1_000)) },
        Tier { name: "Adult".into(), min_principal: U128(near(10_000)) },
    ]
}

fn init() -> ThePit {
    init_with_pool(POOL)
}

fn init_with_pool(pool: &str) -> ThePit {
    env_as(ME, 0, 0);
    ThePit::new(
        acc(BRAIN),
        vec![acc(pool)],
        U128(near(3_000)),
        U128(1_073_000_000 * ONE_TOKEN),
        FEE_BPS,
        BUFFER_BPS,
        tiers(),
        "The Pit".into(),
        "PIT".into(),
        None,
        None,
        None,
        None,
    )
}

#[cfg(feature = "rnear-experimental")]
#[test]
fn rnear_uses_account_details_and_does_not_count_unconfirmed_shares() {
    let mut c = init_with_pool("lst.ref-dev.testnet");
    buy(&mut c, ALICE, near(10));
    env_as(BOB, 2_000, 0);
    let pending = c.rebalance(0);
    drop(pending);
    let receipts = format!("{:?}", near_sdk::test_utils::get_created_receipts());
    assert!(receipts.contains("get_account_details") || receipts.contains("103, 101, 116, 95, 97, 99, 99, 111, 117, 110, 116, 95, 100, 101, 116, 97, 105, 108, 115"));
    env_callback(2_001, true);
    assert!(c.on_staked(0, U128(near(1))));
    assert_eq!(stats(&c, "staked"), 0, "shares must be read from RHEA before counting them");
}

#[cfg(feature = "rnear-experimental")]
#[test]
fn rnear_account_details_parse_with_pending_epoch() {
    let account: PoolAccount = serde_json::from_value(serde_json::json!({
        "account_id": ME,
        "staked_balance": "1200000000000000000000000",
        "unstaked_balance": "100000000000000000000000",
        "unstaked_available_epoch_height": 42,
        "can_withdraw": false
    })).unwrap();
    assert_eq!(account.staked_balance.0, ONE_NEAR * 12 / 10);
    assert_eq!(account.unstaked_balance.0, ONE_NEAR / 10);
    assert!(!account.can_withdraw);
}

fn stats(c: &ThePit, key: &str) -> u128 {
    serde_json::to_value(c.brain_stats()).unwrap()[key].as_str().unwrap().parse().unwrap()
}

fn storage_cost(c: &ThePit) -> u128 {
    use near_contract_standards::storage_management::StorageManagement;
    c.storage_balance_bounds().min.as_yoctonear()
}

fn buy(c: &mut ThePit, who: &str, yocto: u128) -> u128 {
    env_as(who, 1_000, yocto);
    c.buy(U128(0)).0
}

/// Sells attach TICKET_DEPOSIT so they work whether paid now or queued.
fn sell(c: &mut ThePit, who: &str, amount: u128) -> serde_json::Value {
    env_as(who, 2_000, TICKET_DEPOSIT);
    let result = c.sell(U128(amount), U128(0));
    if result.status == "paying" {
        env_callback(2_001, true);
        assert!(c.on_payout(result.ticket_id.unwrap()));
    }
    serde_json::to_value(result).unwrap()
}

fn pool_state(staked: u128, unstaked: u128, can_withdraw: bool) -> PoolAccount {
    PoolAccount {
        account_id: acc(ME),
        staked_balance: U128(staked),
        unstaked_balance: U128(unstaked),
        can_withdraw,
    }
}

/// One full rebalance round-trip: rebalance → pool view → action callback.
/// Returns the label of what happened.
fn rebalance(c: &mut ThePit, now: u64, view: PoolAccount, action_ok: bool) -> String {
    env_as(ALICE, now, 0);
    let _ = c.rebalance(0);
    env_as(ME, now, 0);
    let before = serde_json::to_value(c.brain_stats()).unwrap();
    let out = c.on_pool_state(0, Ok(view.clone()));
    let label = match out {
        near_sdk::PromiseOrValue::Value(s) => return s,
        near_sdk::PromiseOrValue::Promise(_) => {
            let liquid_before: u128 = before["liquid"].as_str().unwrap().parse().unwrap();
            if view.unstaked_balance.0 > 0 && view.can_withdraw {
                "withdraw"
            } else if stats(c, "liquid") < liquid_before {
                "stake"
            } else {
                "unstake"
            }
        }
    };
    env_callback(now, action_ok);
    let amt = match label {
        "withdraw" => view.unstaked_balance.0,
        "stake" => {
            let liquid_before: u128 = before["liquid"].as_str().unwrap().parse().unwrap();
            liquid_before - stats(c, "liquid")
        }
        _ => {
            // unstake amount = target − (liquid + pending), capped by staked
            let target = stats(c, "target_liquid");
            (target - stats(c, "liquid")).min(view.staked_balance.0)
        }
    };
    match label {
        "withdraw" => c.on_withdrawn(0, U128(amt)),
        "stake" => c.on_staked(0, U128(amt)),
        _ => c.on_unstaked(0, U128(amt)),
    };
    label.to_string()
}

#[test]
fn buy_registers_mints_and_books_fee_as_surplus() {
    let mut c = init();
    let cost = storage_cost(&c);
    let deposit = near(100) + cost;

    env_as(ALICE, 1_000, deposit);
    let quoted = c.quote_buy(U128(near(100))).0;
    let out = c.buy(U128(quoted)).0;

    assert_eq!(out, quoted);
    assert_eq!(c.ft_balance_of(acc(ALICE)).0, out);
    assert_eq!(c.ft_total_supply().0, out);
    assert_eq!(stats(&c, "principal"), near(99)); // 1% fee
    assert_eq!(stats(&c, "liquid"), near(100)); // storage cost not accounted
    assert_eq!(stats(&c, "total_fees"), near(1));
    // surplus = fee − safety margin
    assert_eq!(stats(&c, "surplus"), near(1) - ONE_NEAR / 1_000);
}

#[test]
#[should_panic(expected = "Slippage")]
fn buy_respects_min_out() {
    let mut c = init();
    let cost = storage_cost(&c);
    env_as(ALICE, 1_000, near(10) + cost);
    let q = c.quote_buy(U128(near(10))).0;
    c.buy(U128(q + 1));
}

#[test]
#[should_panic(expected = "DepositBelowStorageCost")]
fn first_buy_must_cover_storage() {
    let mut c = init();
    let cost = storage_cost(&c);
    env_as(ALICE, 1_000, cost);
    c.buy(U128(0));
}

#[test]
fn price_rises_with_buys() {
    let mut c = init();
    let p0 = c.spot_price().0;
    buy(&mut c, ALICE, near(500));
    let p1 = c.spot_price().0;
    buy(&mut c, BOB, near(500));
    let p2 = c.spot_price().0;
    assert!(p0 < p1 && p1 < p2);
}

#[test]
fn sell_everything_returns_principal_minus_fees() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(50));
    let b = buy(&mut c, BOB, near(70));

    let ra = sell(&mut c, ALICE, a);
    let rb = sell(&mut c, BOB, b);
    assert_eq!(ra["status"], "paying");
    assert_eq!(rb["status"], "paying");

    assert_eq!(c.ft_total_supply().0, 0);
    // Rounding always favours the reserve: principal can't go negative and
    // only dust is left behind.
    assert!(stats(&c, "principal") < 1_000);
    // Everything left liquid is fees (+ dust + security yoctos).
    let liquid = stats(&c, "liquid");
    assert!(liquid >= stats(&c, "total_fees"));
}

#[test]
#[should_panic(expected = "RequiresAttachedDeposit")]
fn sell_requires_a_deposit() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(10));
    env_as(ALICE, 2_000, 0);
    c.sell(U128(a), U128(0));
}

#[test]
fn instant_sell_keeps_ticket_until_confirmed() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(10));
    let liquid_before = stats(&c, "liquid");
    let quoted = c.quote_sell(U128(a / 2)).0;
    env_as(ALICE, 2_000, TICKET_DEPOSIT);
    let result = c.sell(U128(a / 2), U128(0));
    assert_eq!(result.status, "paying");
    assert!(c.get_queue(None, None)[0].in_flight);
    assert_eq!(c.process_queue(None), 0);
    env_callback(2_001, true);
    assert!(c.on_payout(result.ticket_id.unwrap()));
    assert!(!c.on_payout(result.ticket_id.unwrap()));
    assert!(c.get_queue(None, None).is_empty());
    // Reserve drops by exactly the payout; the yocto is returned, not booked.
    assert_eq!(stats(&c, "liquid"), liquid_before - quoted);
}

/// Audit fix: a sell that has to queue must fund its own ticket storage, so
/// dust sells can't drain the contract's storage float.
#[test]
#[should_panic(expected = "AttachTicketDeposit")]
fn queued_sell_must_fund_its_ticket() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(1_000));
    rebalance(&mut c, 1_000, pool_state(0, 0, false), true);
    env_as(ALICE, 2_000, 1);
    c.sell(U128(a), U128(0));
}

#[test]
fn ticket_records_the_sellers_deposit() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(1_000));
    rebalance(&mut c, 1_000, pool_state(0, 0, false), true);
    let liquid = stats(&c, "liquid");
    assert_eq!(sell(&mut c, ALICE, a)["status"], "queued");
    let t = &c.get_queue(None, None)[0];
    assert_eq!(t.deposit.0, TICKET_DEPOSIT);
    assert_eq!(stats(&c, "liquid"), liquid, "deposit is not reserve money");
}

#[test]
fn get_queue_does_not_overflow() {
    let c = init();
    assert!(c.get_queue(Some(u64::MAX), Some(100)).is_empty());
}

#[test]
fn excess_liquid_is_staked_and_failure_refunds() {
    let mut c = init();
    buy(&mut c, ALICE, near(1_000));
    let principal = stats(&c, "principal"); // ≈ 990
    let funded = stats(&c, "liquid"); // 1000 − storage cost

    // Failed stake: NEAR comes back to liquid.
    assert_eq!(rebalance(&mut c, 5_000, pool_state(0, 0, false), false), "stake");
    assert_eq!(stats(&c, "liquid"), funded);
    assert_eq!(stats(&c, "staked"), 0);
    assert!(!serde_json::to_value(c.brain_stats()).unwrap()["pool_op_in_flight"].as_bool().unwrap());

    // Successful stake: keep buffer (20% of principal) + surplus liquid.
    assert_eq!(rebalance(&mut c, 6_000, pool_state(0, 0, false), true), "stake");
    let liquid = stats(&c, "liquid");
    assert_eq!(liquid, stats(&c, "target_liquid"));
    assert_eq!(liquid, principal / 5 + stats(&c, "surplus"));
    assert_eq!(stats(&c, "staked"), funded - liquid);

    // Nothing more to do.
    let staked = stats(&c, "staked");
    assert_eq!(rebalance(&mut c, 7_000, pool_state(staked, 0, false), true), "Balanced");
}

#[test]
fn staking_rewards_flow_to_the_brain() {
    let mut c = init();
    buy(&mut c, ALICE, near(1_000));
    rebalance(&mut c, 1_000, pool_state(0, 0, false), true);
    let staked = stats(&c, "staked");

    // Harvest the fees right away.
    env_as(BOB, 2_000, 0);
    let fees_paid = c.harvest().0;
    env_callback(2_001, true);
    assert!(c.on_harvest(false));
    assert_eq!(fees_paid, stats(&c, "total_fees") - ONE_NEAR / 1_000);

    // A year passes: the pool reports 5% more staked.
    let rewards = staked / 20;
    let label = rebalance(&mut c, 3_000, pool_state(staked + rewards, 0, false), true);
    assert_eq!(label, "unstake");
    let unstaking = stats(&c, "unstaking");
    assert!(unstaking >= rewards - ONE_NEAR / 1_000);

    // Surplus exists but isn't liquid yet → harvest gets nothing usable.
    assert!(stats(&c, "surplus") >= rewards - ONE_NEAR / 500);
    env_as(BOB, 3_500, 0);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.harvest()));
    assert!(early.is_err(), "rewards are still unstaking");

    // 4 epochs later: withdraw lands in liquid.
    let still_staked = stats(&c, "staked");
    assert_eq!(rebalance(&mut c, 4_000, pool_state(still_staked, unstaking, true), true), "withdraw");
    assert_eq!(stats(&c, "unstaking"), 0);

    env_as(BOB, 5_000, 0);
    let paid = c.harvest().0;
    env_callback(2_001, true);
    assert!(c.on_harvest(false));
    if c.get_harvest_claim(true).is_some() { assert!(c.on_harvest(true)); }
    assert!(paid >= rewards - ONE_NEAR / 500 && paid <= rewards);
    assert_eq!(stats(&c, "total_harvested"), fees_paid + paid);
    // Holders are still fully backed.
    let assets = stats(&c, "liquid") + stats(&c, "staked");
    assert!(assets >= stats(&c, "principal"));
}

#[test]
fn big_sell_is_queued_then_paid_after_unstake() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(1_000));
    rebalance(&mut c, 1_000, pool_state(0, 0, false), true);
    let staked = stats(&c, "staked");

    // Alice dumps everything: more than the 20% buffer.
    let r = sell(&mut c, ALICE, a);
    assert_eq!(r["status"], "queued");
    let owed = stats(&c, "queue_owed");
    assert!(owed > stats(&c, "liquid"));
    assert_eq!(c.get_queue(None, None).len(), 1);

    // Queue can't be paid yet.
    env_as(BOB, 2_500, 0);
    assert_eq!(c.process_queue(None), 0);

    // Rebalance unstakes what's needed; later withdraw; then pay.
    assert_eq!(rebalance(&mut c, 3_000, pool_state(staked, 0, false), true), "unstake");
    let pending = stats(&c, "unstaking");
    let left = stats(&c, "staked");
    assert_eq!(rebalance(&mut c, 4_000, pool_state(left, pending, true), true), "withdraw");

    env_as(BOB, 5_000, 0);
    assert_eq!(c.process_queue(None), 1);
    assert_eq!(stats(&c, "queue_owed"), 0);
    env_callback(10_000, true);
    assert!(c.on_payout(0));
    assert_eq!(stats(&c, "queue_owed"), 0);
    assert_eq!(c.get_queue(None, None).len(), 0);
}

#[test]
fn new_sells_wait_behind_the_queue() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(1_000));
    let b = buy(&mut c, BOB, near(1));
    rebalance(&mut c, 1_000, pool_state(0, 0, false), true);

    assert_eq!(sell(&mut c, ALICE, a)["status"], "queued");
    // Bob's tiny sell would fit in liquid, but FIFO fairness queues it.
    assert_eq!(sell(&mut c, BOB, b)["status"], "queued");
    assert_eq!(c.get_queue(None, None).len(), 2);
}

#[test]
#[should_panic(expected = "PoolOpInFlight")]
fn one_pool_op_at_a_time() {
    let mut c = init();
    buy(&mut c, ALICE, near(100));
    env_as(ALICE, 1_000, 0);
    let _ = c.rebalance(0);
    env_as(BOB, 2_000, 0);
    let _ = c.rebalance(0);
}

#[test]
#[should_panic(expected = "PoolOpInFlight")]
fn unresolved_pool_operation_stays_locked_after_old_timeout() {
    let mut c = init();
    buy(&mut c, ALICE, near(100));
    env_as(ALICE, 1_000, 0);
    let _ = c.rebalance(0);
    env_as(BOB, 1_000 + LOCK_TIMEOUT_MS, 0);
    let _ = c.rebalance(0);
}

#[test]
#[should_panic(expected = "NothingToHarvest")]
fn nothing_to_harvest_on_fresh_contract() {
    let mut c = init();
    env_as(BOB, 1_000, 0);
    c.harvest();
}

#[test]
fn only_brain_can_rotate_brain() {
    let mut c = init();
    env_as(ALICE, 1_000, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_brain(acc(ALICE))));
    assert!(r.is_err());

    env_as(BRAIN, 1_000, 0);
    c.set_brain(acc("brain2.near"));
    assert_eq!(serde_json::to_value(c.brain_stats()).unwrap()["brain"], "brain2.near");
}

#[test]
fn tiers_follow_principal() {
    let mut c = init();
    assert_eq!(serde_json::to_value(c.brain_stats()).unwrap()["tier"]["name"], "Larva");
    buy(&mut c, ALICE, near(1_100));
    assert_eq!(serde_json::to_value(c.brain_stats()).unwrap()["tier"]["name"], "Juvenile");
    assert_eq!(serde_json::to_value(c.brain_stats()).unwrap()["next_tier"]["name"], "Adult");
}

#[test]
#[should_panic(expected = "BadConfig")]
fn rejects_high_fee() {
    env_as(ME, 0, 0);
    ThePit::new(
        acc(BRAIN),
        vec![acc(POOL)],
        U128(near(3_000)),
        U128(1_000_000 * ONE_TOKEN),
        501,
        BUFFER_BPS,
        tiers(),
        "The Pit".into(),
        "PIT".into(),
        None,
        None,
        None,
        None,
    );
}

/// Random buys/sells: holders can always be paid in full by the curve.
#[test]
fn solvency_under_random_trading() {
    let mut c = init();
    let users = ["u0.near", "u1.near", "u2.near", "u3.near", "u4.near"];
    let mut seed: u64 = 0x1234_5678;
    let mut rand = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };

    for _ in 0..400 {
        let who = users[(rand() % 5) as usize];
        if rand() % 3 == 0 {
            let bal = c.ft_balance_of(acc(who)).0;
            if bal > 0 {
                let amt = (bal / 100) * u128::from(rand() % 100 + 1);
                if amt > 0 {
                    sell(&mut c, who, amt.min(bal));
                }
            }
        } else {
            buy(&mut c, who, ONE_NEAR / 10 * u128::from(rand() % 5_000 + 1));
        }
        // Selling the whole supply right now must not exceed principal.
        let supply = c.ft_total_supply().0;
        if supply > 0 {
            let all = c.quote_sell(U128(supply)).0;
            assert!(all <= stats(&c, "principal"));
        }
        // Liquid covers principal + queue (nothing staked in this test).
        assert!(stats(&c, "liquid") >= stats(&c, "principal"));
    }
}

fn init_with_creator(share_bps: u16) -> ThePit {
    env_as(ME, 0, 0);
    ThePit::new(
        acc(BRAIN),
        vec![acc(POOL)],
        U128(near(3_000)),
        U128(1_073_000_000 * ONE_TOKEN),
        FEE_BPS,
        BUFFER_BPS,
        tiers(),
        "Doge Pit".into(),
        "DPIT".into(),
        None,
        None,
        Some(pit::CreatorCut { account_id: acc("creator.near"), share_bps }),
        None,
    )
}

/// Launchpad: the creator gets exactly their share of each harvest, the brain the rest.
#[test]
fn harvest_splits_between_creator_and_brain() {
    let mut c = init_with_creator(3_000); // 30%
    buy(&mut c, ALICE, near(100));
    env_as(BOB, 2_000, 0);
    let paid = c.harvest().0;
    assert_eq!(stats(&c, "total_harvested"), 0);
    env_callback(2_001, true);
    assert!(c.on_harvest(false));
    if c.get_harvest_claim(true).is_some() { assert!(c.on_harvest(true)); }
    let creator = stats(&c, "creator_earned");
    let brain = stats(&c, "total_harvested");
    assert_eq!(creator, paid * 3_000 / 10_000);
    assert_eq!(brain + creator, paid);
}

#[test]
fn no_creator_means_the_brain_eats_everything() {
    let mut c = init();
    buy(&mut c, ALICE, near(100));
    env_as(BOB, 2_000, 0);
    let paid = c.harvest().0;
    assert_eq!(stats(&c, "total_harvested"), 0);
    env_callback(2_001, true);
    assert!(c.on_harvest(false));
    if c.get_harvest_claim(true).is_some() { assert!(c.on_harvest(true)); }
    assert_eq!(stats(&c, "total_harvested"), paid);
    assert_eq!(stats(&c, "creator_earned"), 0);
}

#[test]
#[should_panic(expected = "BadConfig")]
fn creator_share_is_capped_at_half() {
    init_with_creator(5_001);
}

#[test]
fn failed_payout_restores_liquid_and_can_retry_without_double_payment() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(10));
    let before = stats(&c, "liquid");
    env_as(ALICE, 2_000, TICKET_DEPOSIT);
    let sale = c.sell(U128(a), U128(0));
    let id = sale.ticket_id.unwrap();
    assert_eq!(c.process_queue(None), 0);
    env_callback(2_001, false);
    assert!(!c.on_payout(id));
    assert_eq!(stats(&c, "liquid"), before);
    assert_eq!(stats(&c, "queue_owed"), sale.near_out.0);
    assert!(!c.on_payout(id));
    assert_eq!(stats(&c, "liquid"), before);
    env_as(BOB, 3_000, 0);
    assert_eq!(c.process_queue(None), 1);
    assert_eq!(c.process_queue(None), 0);
    env_callback(3_001, true);
    assert!(c.on_payout(id));
    assert_eq!(stats(&c, "liquid"), before - sale.near_out.0);
    assert_eq!(stats(&c, "queue_owed"), 0);
    assert!(!c.on_payout(id));
}

#[test]
fn payout_callbacks_can_arrive_out_of_order() {
    let mut c = init();
    let a = buy(&mut c, ALICE, near(10));
    let b = buy(&mut c, BOB, near(10));
    env_as(ALICE, 2_000, TICKET_DEPOSIT);
    c.sell(U128(a), U128(0));
    env_as(BOB, 2_001, TICKET_DEPOSIT);
    c.sell(U128(b), U128(0));
    assert_eq!(c.process_queue(Some(10)), 1);
    env_callback(2_002, true);
    assert!(c.on_payout(1));
    assert_eq!(c.get_queue(None, None).len(), 1);
    env_callback(2_003, false);
    assert!(!c.on_payout(0));
    assert_eq!(c.process_queue(None), 1);
    env_callback(2_004, true);
    assert!(c.on_payout(0));
    assert!(c.get_queue(None, None).is_empty());
    assert_eq!(stats(&c, "queue_owed"), 0);
}

#[test]
fn pool_view_for_another_account_cannot_create_surplus() {
    let mut c = init();
    buy(&mut c, ALICE, near(10));
    let principal = stats(&c, "principal");
    let liquid = stats(&c, "liquid");
    env_as(BOB, 5_000, 0);
    drop(c.rebalance(0));
    env_as(ME, 5_001, 0);
    let mut other_position = pool_state(near(1_000), near(500), true);
    other_position.account_id = acc(BOB);
    let result = c.on_pool_state(0, Ok(other_position));
    assert!(matches!(result, near_sdk::PromiseOrValue::Value(label) if label == "PoolAccountMismatch"));
    assert_eq!(stats(&c, "staked"), 0);
    assert_eq!(stats(&c, "unstaking"), 0);
    assert_eq!(stats(&c, "principal"), principal);
    assert_eq!(stats(&c, "liquid"), liquid);
    assert!(!c.brain_stats().pool_op_in_flight);
}

#[test]
fn late_pool_callback_releases_lock_before_next_operation() {
    let mut c = init();
    env_as(ALICE, 1_000, 0);
    drop(c.rebalance(0));
    env_as(ME, 1_000 + LOCK_TIMEOUT_MS * 10, 0);
    let result = c.on_pool_state(0, Ok(pool_state(0, 0, false)));
    assert!(matches!(result, near_sdk::PromiseOrValue::Value(label) if label == "Balanced"));
    assert!(!c.brain_stats().pool_op_in_flight);
    env_as(BOB, 1_001 + LOCK_TIMEOUT_MS * 10, 0);
    drop(c.rebalance(0));
    assert!(c.brain_stats().pool_op_in_flight);
}
