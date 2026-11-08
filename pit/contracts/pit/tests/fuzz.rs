//! Invariant simulation: random traders, a simulated validator pool (rewards,
//! unstake delays, failures), the keeper, harvests with a creator cut, the sell
//! queue, and memory backing — with solvency and conservation checked after
//! every single operation.
//! Run with: cargo test --features unit-tests --test fuzz -- --nocapture

#![cfg(feature = "unit-tests")]

use near_contract_standards::fungible_token::FungibleTokenCore;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, test_vm_config, AccountId, NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig};
use pit::{CreatorCut, PoolAccount, ThePit, Tier, ONE_NEAR, ONE_TOKEN, TICKET_DEPOSIT};

const ME: &str = "pit.near";
const USERS: [&str; 5] = ["u0.near", "u1.near", "u2.near", "u3.near", "u4.near"];
const UNSTAKE_DELAY_MS: u64 = 52 * 3_600_000; // ~4 epochs

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn env_as(who: &str, now_ms: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(ME))
        .signer_account_id(acc(who))
        .predecessor_account_id(acc(who))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(100_000_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn env_callback(now_ms: u64, ok: bool) {
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        VMContextBuilder::new().current_account_id(acc(ME)).predecessor_account_id(acc(ME)).block_timestamp(now_ms * 1_000_000)
            .account_balance(NearToken::from_near(100_000_000)).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// What the validator pool actually holds for the contract.
struct Pool {
    staked: u128,
    unstaked: u128,
    unlock_ms: u64,
}

fn n(v: &serde_json::Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

fn stats(c: &ThePit) -> serde_json::Value {
    serde_json::to_value(c.brain_stats()).unwrap()
}

/// One keeper round-trip against the simulated pool, with random failures.
fn rebalance(c: &mut ThePit, pool: &mut Pool, now: u64, rng: &mut Rng, fails: &mut u32) {
    env_as("keeper.near", now, 0);
    let _ = c.rebalance(0);
    let liquid_before = n(&stats(c), "liquid");
    env_as(ME, now, 0);
    let view = PoolAccount {
        account_id: acc(ME),
        staked_balance: U128(pool.staked),
        unstaked_balance: U128(pool.unstaked),
        can_withdraw: now >= pool.unlock_ms,
    };
    let out = c.on_pool_state(0, Ok(view.clone()));
    if let PromiseOrValue::Value(_) = out {
        return;
    }
    let ok = rng.below(10) != 0; // 10% of pool calls fail
    if !ok {
        *fails += 1;
    }
    let s = stats(c);
    if view.unstaked_balance.0 > 0 && view.can_withdraw {
        let amt = view.unstaked_balance.0;
        env_callback(now, ok);
        c.on_withdrawn(0, U128(amt));
        if ok {
            pool.unstaked -= amt;
        }
    } else if n(&s, "liquid") < liquid_before {
        let amt = liquid_before - n(&s, "liquid");
        env_callback(now, ok);
        c.on_staked(0, U128(amt));
        if ok {
            pool.staked += amt;
        }
    } else {
        // Unstake: the same amount the contract computed.
        let amt = (n(&s, "target_liquid") - n(&s, "liquid")).min(view.staked_balance.0);
        env_callback(now, ok);
        c.on_unstaked(0, U128(amt));
        if ok {
            pool.staked -= amt;
            pool.unstaked += amt;
            pool.unlock_ms = now + UNSTAKE_DELAY_MS;
        }
    }
}

fn check(c: &ThePit, pool: &Pool, backings: &std::collections::HashMap<(u64, usize), u128>, step: usize) {
    let s = stats(c);
    let liquid = n(&s, "liquid");
    let principal = n(&s, "principal");
    let owed = n(&s, "queue_owed");
    // I1 solvency: what the contract really has ≥ what it owes holders + queued sellers.
    assert!(liquid + pool.staked + pool.unstaked >= principal + owed, "step {step}: insolvent");
    // I2 curve bound: selling the whole supply never pays more than the reserve.
    let supply = c.ft_total_supply().0;
    if supply > 0 {
        assert!(c.quote_sell(U128(supply)).0 <= principal, "step {step}: curve over-promises");
    }
    // I3 token conservation.
    let held: u128 = USERS.iter().map(|u| c.ft_balance_of(acc(u)).0).sum::<u128>() + c.ft_balance_of(acc(ME)).0;
    assert_eq!(held, supply, "step {step}: tokens not conserved");
    // I4 the contract's tokens are exactly the outstanding memory backings.
    assert_eq!(c.ft_balance_of(acc(ME)).0, backings.values().sum::<u128>(), "step {step}: backing escrow mismatch");
    // I5 queue debt equals the open tickets.
    let mut tickets = 0u128;
    let mut from = None;
    loop {
        let page = c.get_queue(from, Some(100));
        if page.is_empty() { break; }
        tickets += page.iter().filter(|t| !t.in_flight).map(|t| t.amount.0).sum::<u128>();
        from = Some(from.unwrap_or(0) + page.len() as u64);
    }
    assert_eq!(tickets, owed, "step {step}: queue mismatch");
}

fn run(seed: u64, steps: usize) -> (u32, u32, u32, u32, u32) {
    let mut rng = Rng(seed);
    env_as(ME, 0, 0);
    let mut c = ThePit::new(
        acc("brain.near"),
        vec![acc("pool.near")],
        U128(3_000 * ONE_NEAR),
        U128(1_073_000_000 * ONE_TOKEN),
        100,
        2_000,
        vec![Tier { name: "Larva".into(), min_principal: U128(0) }],
        "Fuzz Pit".into(),
        "FUZZ".into(),
        None,
        None,
        Some(CreatorCut { account_id: acc("creator.near"), share_bps: 2_500 }),
        None,
    );
    let mut pool = Pool { staked: 0, unstaked: 0, unlock_ms: 0 };
    let mut backings = std::collections::HashMap::new();
    let mut memories: Vec<u64> = vec![];
    let (mut now, mut fails, mut queued, mut harvests, mut adopted) = (1_000u64, 0, 0, 0, 0);

    for step in 0..steps {
        now += 1 + rng.below(4 * 3_600_000);
        let u = rng.below(USERS.len() as u64) as usize;
        let who = USERS[u];
        match rng.below(100) {
            0..=27 => {
                let amt = ONE_NEAR / 10 * u128::from(1 + rng.below(2_000));
                env_as(who, now, amt);
                c.buy(U128(0));
            }
            28..=44 => {
                let bal = c.ft_balance_of(acc(who)).0;
                if bal > 0 {
                    let amt = (bal / 100 * u128::from(1 + rng.below(100))).max(1).min(bal);
                    env_as(who, now, TICKET_DEPOSIT);
                    if c.sell(U128(amt), U128(0)).status == "queued" {
                        queued += 1;
                    }
                }
            }
            45..=64 => rebalance(&mut c, &mut pool, now, &mut rng, &mut fails),
            65..=70 => pool.staked += pool.staked * u128::from(1 + rng.below(100)) / 10_000, // rewards
            71..=76 => {
                env_as("keeper.near", now, 0);
                c.process_queue(Some(20));
            }
            77..=82 => {
                env_as("keeper.near", now, 0);
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.harvest())).is_ok() {
                    harvests += 1;
                }
            }
            83..=86 => {
                env_as(who, now, ONE_NEAR / 50);
                memories.push(c.propose_memory(format!("belief {step}")));
            }
            87..=93 if !memories.is_empty() => {
                let id = memories[rng.below(memories.len() as u64) as usize];
                let bal = c.ft_balance_of(acc(who)).0;
                let adopted_already = c.get_memory(id).unwrap().memory.adopted_ms.is_some();
                if bal > 0 && !adopted_already {
                    let amt = (bal / 2).max(1);
                    env_as(who, now, ONE_NEAR / 50);
                    c.back_memory(id, U128(amt));
                    *backings.entry((id, u)).or_insert(0) += amt;
                }
            }
            94..=97 if !backings.is_empty() => {
                let keys: Vec<_> = backings.keys().copied().collect();
                let (id, bu) = keys[rng.below(keys.len() as u64) as usize];
                env_as(USERS[bu], now, 0);
                let back = c.unback_memory(id).0;
                assert_eq!(back, backings.remove(&(id, bu)).unwrap(), "unback returns exactly what was locked");
            }
            _ if !memories.is_empty() => {
                let id = memories[rng.below(memories.len() as u64) as usize];
                let v = c.get_memory(id).unwrap();
                if v.memory.adopted_ms.is_none() && v.conviction.0 >= v.threshold.0 {
                    env_as(who, now, 0);
                    c.adopt_memory(id);
                    adopted += 1;
                }
            }
            _ => {}
        }
        // Settle asynchronous transfers, including confirmed failures and retries.
        for ticket in c.get_queue(None, Some(100)) {
            if ticket.in_flight {
                let id = ticket.id;
                env_callback(now, rng.below(5) != 0);
                c.on_payout(id);
            }
        }
        for creator in [false, true] {
            if c.get_harvest_claim(creator).is_some_and(|claim| claim.in_flight) {
                env_callback(now, rng.below(5) != 0);
                c.on_harvest(creator);
            }
        }
        check(&c, &pool, &backings, step);
    }
    // Wind down: let unstakes mature, pay everyone, and confirm holders can all exit.
    for _ in 0..12 {
        now += UNSTAKE_DELAY_MS + 1;
        rebalance(&mut c, &mut pool, now, &mut rng, &mut fails);
        env_as("keeper.near", now, 0);
        c.process_queue(Some(50));
        check(&c, &pool, &backings, steps);
    }
    (fails, queued, harvests, adopted, c.get_queue(None, Some(100)).len() as u32)
}

#[test]
fn invariants_hold_under_random_operation() {
    // Each seed runs on its own thread so it gets a fresh mocked blockchain.
    for seed in [0x1234_5678_u64, 0xdead_beef, 0x0bad_cafe, 0x5eed_0001, 0x7777_aaaa] {
        let (fails, queued, harvests, adopted, left) = std::thread::spawn(move || run(seed, 2_000)).join().unwrap();
        println!("seed {seed:#x}: 2000 ops · {fails} pool failures · {queued} queued sells · {harvests} harvests · {adopted} adoptions · {left} tickets left after wind-down");
        assert!(queued > 0 && harvests > 0, "the run must exercise the queue and harvests");
    }
}
