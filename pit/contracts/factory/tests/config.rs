#![cfg(feature = "unit-tests")]

use near_sdk::{json_types::U128, test_utils::VMContextBuilder, testing_env, AccountId};
use pit_factory::{CoinDefaults, PitFactory, Tier, ONE_NEAR};

fn account(name: &str) -> AccountId { name.parse().unwrap() }
fn defaults() -> CoinDefaults {
    CoinDefaults {
        virtual_near: U128(3_000 * ONE_NEAR),
        virtual_tokens: U128(1_073_000_000 * 10u128.pow(18)),
        fee_bps: 100, buffer_bps: 2_000,
        tiers: vec![Tier { name: "Larva".into(), min_principal: U128(0) }],
    }
}
fn init(pools: Vec<AccountId>, config: CoinDefaults) -> PitFactory {
    testing_env!(VMContextBuilder::new().current_account_id(account("factory.near")).build());
    PitFactory::new("ab".repeat(32), account("brain.near"), None, pools, None, vec![], config, U128(ONE_NEAR / 20))
}
#[test]
fn accepts_valid_immutable_curve_config() {
    assert_eq!(init(vec![account("pool.near")], defaults()).get_config().defaults.fee_bps, 100);
}
#[test]
#[should_panic(expected = "BadConfig")]
fn rejects_duplicate_pool_positions() {
    init(vec![account("pool.near"), account("pool.near")], defaults());
}
#[test]
#[should_panic(expected = "BadConfig")]
fn rejects_excessive_fee_before_publishing_code() {
    let mut config = defaults(); config.fee_bps = 501;
    init(vec![account("pool.near")], config);
}
#[test]
#[should_panic(expected = "BadConfig")]
fn rejects_insufficient_buffer_before_publishing_code() {
    let mut config = defaults(); config.buffer_bps = 999;
    init(vec![account("pool.near")], config);
}
#[test]
#[should_panic(expected = "BadConfig")]
fn rejects_nonzero_initial_tier_before_publishing_code() {
    let mut config = defaults(); config.tiers[0].min_principal = U128(1);
    init(vec![account("pool.near")], config);
}

fn callback(ok: bool) {
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config};
    testing_env!(VMContextBuilder::new().current_account_id(account("factory.near"))
        .predecessor_account_id(account("factory.near"))
        .account_balance(near_sdk::NearToken::from_near(100)).build(),
        test_vm_config(), RuntimeFeesConfig::test(), Default::default(),
        vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
}
fn launch(factory: &mut PitFactory, attached: u128) {
    testing_env!(VMContextBuilder::new().current_account_id(account("factory.near"))
        .predecessor_account_id(account("creator.near"))
        .account_balance(near_sdk::NearToken::from_near(100))
        .attached_deposit(near_sdk::NearToken::from_yoctonear(attached)).build());
    drop(factory.create_coin("meme".into(), "Meme".into(), None, None, 0));
}
#[test]
fn failed_launch_refunds_retain_claim_until_confirmed_and_retry_safely() {
    use near_sdk::json_types::U64;
    let mut factory=init(vec![account("pool.near")],defaults());
    callback(true); assert!(factory.on_published());
    let deposit=factory.create_cost(None).0;
    launch(&mut factory,deposit);
    assert_eq!(factory.get_launch_status(U64(0)),"creating");
    callback(false);drop(factory.on_coin_created(U64(0)));
    let claim=factory.get_refund(U64(0)).unwrap();
    assert_eq!(claim.amount.0,deposit-pit_factory::REFUND_STORAGE_FEE);
    assert!(claim.in_flight);
    assert_eq!(factory.get_launch_status(U64(0)),"refunding");
    assert!(!factory.retry_refund(U64(0)));
    callback(false);assert!(!factory.on_refund(U64(0)));
    assert!(!factory.get_refund(U64(0)).unwrap().in_flight);
    assert_eq!(factory.get_launch_status(U64(0)),"refund_retryable");
    assert!(!factory.on_refund(U64(0)));
    assert!(factory.retry_refund(U64(0)));
    assert!(!factory.retry_refund(U64(0)));
    callback(true);assert!(factory.on_refund(U64(0)));
    assert!(factory.get_refund(U64(0)).is_none());
    assert_eq!(factory.get_launch_status(U64(0)),"settled");
    assert!(!factory.retry_refund(U64(0)));
    assert!(!factory.on_refund(U64(0)));
    assert!(matches!(factory.on_coin_created(U64(0)),near_sdk::PromiseOrValue::Value(false)));
}
#[test]
fn successful_launch_excess_is_recoverable_and_exact_cost_needs_no_claim() {
    use near_sdk::json_types::U64;
    let mut factory=init(vec![account("pool.near")],defaults());
    callback(true);assert!(factory.on_published());
    let deposit=factory.create_cost(None).0;
    launch(&mut factory,deposit+ONE_NEAR);
    callback(true);drop(factory.on_coin_created(U64(0)));
    assert_eq!(factory.get_refund(U64(0)).unwrap().amount.0,ONE_NEAR);
    drop(factory.on_coin_created(U64(0)));
    callback(true);assert!(factory.on_refund(U64(0)));
    assert_eq!(factory.coin_count(),1);
}

#[test]
fn maximum_account_refund_claim_is_funded_by_retained_storage_fee() {
    use near_sdk::{collections::LookupMap, json_types::U64, env};
    use pit_factory::{RefundClaim, REFUND_STORAGE_FEE};
    testing_env!(VMContextBuilder::new().current_account_id(account("factory.near")).build());
    let mut refunds: LookupMap<u64,RefundClaim>=LookupMap::new(b"refund-storage-test".to_vec());
    let before=env::storage_usage();
    refunds.insert(&0,&RefundClaim{id:U64(0),account_id:account(&"a".repeat(64)),amount:U128(u128::MAX),in_flight:true});
    let used=env::storage_usage()-before;
    assert!(u128::from(used)*env::storage_byte_cost().as_yoctonear()<=REFUND_STORAGE_FEE,"claim uses {used} bytes");
}

#[test]
fn exact_cost_success_needs_no_refund_claim() {
    use near_sdk::json_types::U64;
    let mut factory=init(vec![account("pool.near")],defaults());
    callback(true);assert!(factory.on_published());
    let deposit=factory.create_cost(None).0;
    launch(&mut factory,deposit);
    callback(true);drop(factory.on_coin_created(U64(0)));
    assert!(factory.get_refund(U64(0)).is_none());
    assert_eq!(factory.get_launch_status(U64(0)),"settled");
}

fn callback_with_balance(ok: bool, yocto: u128) {
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config};
    testing_env!(VMContextBuilder::new().current_account_id(account("factory.near"))
        .predecessor_account_id(account("factory.near"))
        .account_balance(near_sdk::NearToken::from_yoctonear(yocto)).build(),
        test_vm_config(), RuntimeFeesConfig::test(), Default::default(),
        vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
}

/// A failed launch's NEAR comes back from the child in a separate receipt.
/// If the callback runs first and the float can't cover the refund, the claim
/// must wait (retryable) instead of failing the callback and stranding the launch.
#[test]
fn failed_launch_refund_waits_for_returning_funds_instead_of_stranding() {
    use near_sdk::json_types::U64;
    let mut factory = init(vec![account("pool.near")], defaults());
    callback(true); assert!(factory.on_published());
    let deposit = 50 * ONE_NEAR;
    launch(&mut factory, deposit);
    // The factory is short: almost nothing beyond its own storage.
    callback_with_balance(false, ONE_NEAR / 10);
    assert!(matches!(factory.on_coin_created(U64(0)), near_sdk::PromiseOrValue::Value(false)));
    let claim = factory.get_refund(U64(0)).expect("claim recorded, not lost");
    assert_eq!(claim.amount.0, deposit - pit_factory::REFUND_STORAGE_FEE);
    assert!(!claim.in_flight);
    assert_eq!(factory.get_launch_status(U64(0)), "refund_retryable");
    // Still short: retry is a no-op, never an overdraft.
    callback_with_balance(true, ONE_NEAR / 10);
    assert!(!factory.retry_refund(U64(0)));
    // Funds are back: anyone can push it through.
    callback_with_balance(true, 100 * ONE_NEAR);
    assert!(factory.retry_refund(U64(0)));
    assert!(factory.get_refund(U64(0)).unwrap().in_flight);
    callback(true); assert!(factory.on_refund(U64(0)));
    assert_eq!(factory.get_launch_status(U64(0)), "settled");
}
