//! A pool call that succeeds must be booked as a success even if the pool's
//! method returns a value. Otherwise `on_staked` puts NEAR that is actually
//! staked back into `liquid`, and `harvest` pays holders' backing to the brain.
//! Run with: cargo test --features unit-tests --test pool_result

#![cfg(feature = "unit-tests")]

use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, test_vm_config, AccountId, NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig};
use pit::{PoolAccount, ThePit, Tier, ONE_NEAR, ONE_TOKEN};

const ME: &str = "pit.near";

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn env_as(who: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(ME))
        .predecessor_account_id(acc(who))
        .account_balance(NearToken::from_near(1_000_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn env_callback(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new().current_account_id(acc(ME)).predecessor_account_id(acc(ME))
            .account_balance(NearToken::from_near(1_000_000)).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn n(v: &serde_json::Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

/// Buy 100 NEAR, then stake the excess, with the pool's reply given by `reply`.
/// Then one routine keeper sync. Returns (principal, liquid, staked, surplus).
fn stake_with_reply(reply: PromiseResult) -> (u128, u128, u128, u128) {
    env_as(ME, 0);
    let mut c = ThePit::new(
        acc("brain.near"), vec![acc("pool.near")], U128(3_000 * ONE_NEAR), U128(1_073_000_000 * ONE_TOKEN),
        100, 2_000, vec![Tier { name: "Larva".into(), min_principal: U128(0) }],
        "Pool Result".into(), "PR".into(), None, None, None, None,
    );
    env_as("alice.near", 100 * ONE_NEAR);
    c.buy(U128(0));

    env_as("keeper.near", 0);
    let _ = c.rebalance(0);
    env_as(ME, 0);
    let liquid_before = n(&serde_json::to_value(c.brain_stats()).unwrap(), "liquid");
    let view = PoolAccount { account_id: acc(ME), staked_balance: U128(0), unstaked_balance: U128(0), can_withdraw: false };
    let PromiseOrValue::Promise(_) = c.on_pool_state(0, Ok(view)) else { panic!("expected a stake") };
    let staked_amount = liquid_before - n(&serde_json::to_value(c.brain_stats()).unwrap(), "liquid");
    env_callback(reply);
    c.on_staked(0, U128(staked_amount));
    // The keeper's next routine sync reads what the pool really holds.
    env_as("keeper.near", 0);
    let _ = c.rebalance(0);
    env_as(ME, 0);
    let truth = PoolAccount { account_id: acc(ME), staked_balance: U128(staked_amount), unstaked_balance: U128(0), can_withdraw: false };
    if let PromiseOrValue::Promise(_) = c.on_pool_state(0, Ok(truth)) {
        env_callback(PromiseResult::Successful(vec![]));
        c.on_unstaked(0, U128(0));
    }
    let s = serde_json::to_value(c.brain_stats()).unwrap();
    (n(&s, "principal"), n(&s, "liquid"), n(&s, "staked"), n(&s, "surplus"))
}

#[test]
fn a_pool_success_with_a_return_value_is_still_a_success() {
    // Baseline: the standard staking pool returns nothing.
    // Each case on its own thread: a fresh mocked blockchain.
    let (principal, liquid, staked, surplus) =
        std::thread::spawn(|| stake_with_reply(PromiseResult::Successful(vec![]))).join().unwrap();
    println!("empty result:     principal {principal} liquid {liquid} staked {staked} surplus {surplus}");
    assert!(staked > 0 && surplus < ONE_NEAR, "baseline: staked is booked, surplus is just the fee");

    // Same successful stake, but the pool's method returned a value (e.g. `true`).
    let (principal2, liquid2, staked2, surplus2) =
        std::thread::spawn(|| stake_with_reply(PromiseResult::Successful(b"true".to_vec()))).join().unwrap();
    println!("non-empty result: principal {principal2} liquid {liquid2} staked {staked2} surplus {surplus2}");
    assert_eq!(staked2, staked, "a successful stake must be booked as staked");
    assert_eq!(surplus2, surplus, "and must not create phantom harvestable surplus");
}
