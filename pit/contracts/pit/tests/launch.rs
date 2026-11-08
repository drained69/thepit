//! Gated-launch tests: passes signed exactly like tee-gate signs them.
//! Run with: cargo test --features unit-tests
//!
//! Covers: not-started · pass required while gated · happy path ·
//! forged signer · stolen pass · replay · expiry · wrong sale · wrong epoch ·
//! pass cap · per-buyer epoch cap across passes · garbage sig · open phase ·
//! sells during the gated phase · no-launch contracts are open from block one.

#![cfg(feature = "unit-tests")]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use pit::{GatedEpoch, ThePit, LaunchConfig, Tier, VerifierKey, ONE_NEAR, ONE_TOKEN, PASS_STORAGE_FEE};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken};
use serde_json::json;

const ME: &str = "pit.near";
const ALICE: &str = "alice.near";
const BOT: &str = "sniper-bot.near";
const SALE: &str = "PIT-001";

const T_PRE: u64 = 500;
const T_START: u64 = 1_000;
const T_E0_END: u64 = 10_000;
const T_E1_END: u64 = 20_000;
const T_OPEN: u64 = 25_000;

const VERIFIER_SEED: [u8; 32] = [7u8; 32];
const FORGER_SEED: [u8; 32] = [13u8; 32];

/// Epoch 0: 2M tokens per buyer; epoch 1: 5M.
const E0_CAP: u128 = 2_000_000;
const E1_CAP: u128 = 5_000_000;

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn env_as(who: &str, now_ms: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(ME))
        .signer_account_id(acc(who))
        .predecessor_account_id(acc(who))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(1_000_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn launch() -> LaunchConfig {
    LaunchConfig {
        sale_id: SALE.into(),
        starts_at_ms: T_START,
        gated_epochs: vec![
            GatedEpoch { ends_at_ms: T_E0_END, per_buyer_max_tokens: U128(E0_CAP) },
            GatedEpoch { ends_at_ms: T_E1_END, per_buyer_max_tokens: U128(E1_CAP) },
        ],
        verifiers: vec![VerifierKey {
            pubkey_hex: hex::encode(SigningKey::from_bytes(&VERIFIER_SEED).verifying_key().as_bytes()),
            name: "human-gate-sim-1".into(),
            evidence_hash_hex: "ab".repeat(32),
        }],
        agent_registry: None,
    }
}

fn init(launch: Option<LaunchConfig>) -> ThePit {
    env_as(ME, 0, 0);
    ThePit::new(
        acc("brain.near"),
        vec![acc("pool.near")],
        U128(3_000 * ONE_NEAR),
        U128(1_073_000_000 * ONE_TOKEN),
        100,
        2_000,
        vec![Tier { name: "Larva".into(), min_principal: U128(0) }],
        "The Pit".into(),
        "PIT".into(),
        None,
        launch,
        None,
        None,
    )
}

/// Pass JSON in tee-gate's field order (serde_json of its PassToken).
fn pass(buyer: &str, epoch: u32, max_tokens: u128, expires: u64, nonce: &str) -> String {
    json!({
        "v": 1, "sale": SALE, "kind": "human", "buyer": buyer, "epoch": epoch,
        "max_amount": max_tokens.to_string(), "nonce": nonce, "expires_at_ms": expires,
    })
    .to_string()
}

fn sign(seed: [u8; 32], p: &str) -> String {
    B64.encode(SigningKey::from_bytes(&seed).sign(p.as_bytes()).to_bytes())
}

fn nonce(i: u8) -> String {
    format!("{:064x}", i)
}

/// 0.01 NEAR buys ≈ 3.5k tokens at launch price; well under every cap.
const SMALL: u128 = ONE_NEAR / 100;

fn buy_with(c: &mut ThePit, who: &str, now: u64, deposit: u128, p: &str, sig: &str) -> u128 {
    env_as(who, now, deposit);
    c.buy_with_pass(p.into(), sig.into(), U128(0)).0
}

fn expect_panic<F: FnOnce()>(f: F, needle: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let msg = match r {
        Ok(()) => panic!("expected panic containing {needle}"),
        Err(e) => e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    };
    assert!(msg.contains(needle), "expected {needle}, got {msg}");
}

#[test]
fn nobody_buys_before_launch() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_PRE, SMALL, &p, &s); }, "NotInGatedPhase");
    env_as(BOT, T_PRE, SMALL);
    expect_panic(|| { c.buy(U128(0)); }, "LaunchNotStarted");
    assert_eq!(serde_json::to_value(c.launch_info()).unwrap()["phase"], "not_started");
}

#[test]
fn snipers_without_a_pass_get_nothing() {
    let mut c = init(Some(launch()));
    env_as(BOT, T_START, 100 * ONE_NEAR);
    expect_panic(|| { c.buy(U128(0)); }, "PassRequired");
    assert_eq!(c.ft_total_supply().0, 0);
}

#[test]
fn human_with_pass_buys_on_the_curve() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    let out = buy_with(&mut c, ALICE, T_START + 1, SMALL, &p, &s);
    assert!(out > 0);
    assert_eq!(c.ft_balance_of(acc(ALICE)).0, out);
    assert_eq!(c.gated_bought(acc(ALICE), 0).0, out);
    assert!(c.pass_used(p));
    assert_eq!(serde_json::to_value(c.launch_info()).unwrap()["phase"], "gated");
    assert_eq!(serde_json::to_value(c.launch_info()).unwrap()["epoch"], 0);
}

#[test]
fn forged_signer_is_rejected() {
    let mut c = init(Some(launch()));
    let p = pass(BOT, 0, E0_CAP, T_E0_END, &nonce(1));
    let s = sign(FORGER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, BOT, T_START, SMALL, &p, &s); }, "PassUnknownVerifier");
}

#[test]
fn tampered_pass_breaks_the_signature() {
    let mut c = init(Some(launch()));
    let p = pass(BOT, 0, 10, T_E0_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    let bigger = p.replace("\"max_amount\":\"10\"", "\"max_amount\":\"999999999\"");
    expect_panic(|| { buy_with(&mut c, BOT, T_START, SMALL, &bigger, &s); }, "PassUnknownVerifier");
}

#[test]
fn stolen_pass_is_useless() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, BOT, T_START, SMALL, &p, &s); }, "PassNotForYou");
}

#[test]
fn pass_is_one_use() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    buy_with(&mut c, ALICE, T_START, SMALL, &p, &s);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START + 5, SMALL, &p, &s); }, "PassReplay");
}

#[test]
fn expired_pass_is_rejected() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_START + 100, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START + 101, SMALL, &p, &s); }, "PassExpired");
}

#[test]
fn pass_for_another_sale_is_rejected() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1)).replace(SALE, "HUMAN-001");
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START, SMALL, &p, &s); }, "PassWrongSale");
}

#[test]
fn pass_for_another_epoch_is_rejected() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 1, E1_CAP, T_E1_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START, SMALL, &p, &s); }, "PassWrongEpoch");
}

#[test]
fn pass_cap_limits_tokens() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, 1_000, T_E0_END, &nonce(1)); // 1k tokens max
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START, SMALL, &p, &s); }, "PassExceedsAmount");
    assert_eq!(c.ft_total_supply().0, 0);
}

#[test]
fn per_buyer_cap_holds_across_passes() {
    let mut c = init(Some(launch()));
    // ~1.5M tokens per 4.2 NEAR at launch price; two such passes exceed 2M.
    let deposit = 42 * ONE_NEAR / 10;
    let p1 = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let out1 = buy_with(&mut c, ALICE, T_START, deposit, &p1, &sign(VERIFIER_SEED, &p1));
    assert!(out1 > 1_000_000 * ONE_TOKEN && out1 < E0_CAP * ONE_TOKEN);

    let p2 = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(2));
    let s2 = sign(VERIFIER_SEED, &p2);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START + 1, deposit, &p2, &s2); }, "PerBuyerCap");

    // Next epoch has its own, larger cap.
    let p3 = pass(ALICE, 1, E1_CAP, T_E1_END, &nonce(3));
    let out3 = buy_with(&mut c, ALICE, T_E0_END, deposit, &p3, &sign(VERIFIER_SEED, &p3));
    assert!(out3 > 0);
    assert_eq!(c.gated_bought(acc(ALICE), 1).0, out3);
}

#[test]
fn garbage_signature_is_rejected() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    expect_panic(|| { buy_with(&mut c, ALICE, T_START, SMALL, &p, "not-base64!"); }, "PassMalformed");
}

#[test]
fn curve_opens_to_everyone_after_gated_epochs() {
    let mut c = init(Some(launch()));
    env_as(BOT, T_OPEN, ONE_NEAR);
    let out = c.buy(U128(0)).0;
    assert!(out > 0);
    assert_eq!(serde_json::to_value(c.launch_info()).unwrap()["phase"], "open");
    let p = pass(ALICE, 1, E1_CAP, T_OPEN + 1_000, &nonce(9));
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_OPEN, SMALL, &p, &s); }, "NotInGatedPhase");
}

#[test]
fn humans_can_sell_during_the_gated_phase() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let out = buy_with(&mut c, ALICE, T_START, ONE_NEAR, &p, &sign(VERIFIER_SEED, &p));
    env_as(ALICE, T_START + 10, pit::TICKET_DEPOSIT);
    assert_eq!(c.sell(U128(out), U128(0)).status, "paying");
}

#[test]
fn no_launch_means_open_from_the_start() {
    let mut c = init(None);
    env_as(ALICE, 0, ONE_NEAR);
    assert!(c.buy(U128(0)).0 > 0);
}

#[test]
fn launch_config_is_validated() {
    let mut bad = launch();
    bad.verifiers[0].pubkey_hex = "zz".into();
    expect_panic(|| { init(Some(bad)); }, "BadConfig");
    let mut bad = launch();
    bad.gated_epochs[1].ends_at_ms = T_E0_END; // not increasing
    expect_panic(|| { init(Some(bad)); }, "BadConfig");
}

/// Audit fix: a gated buy funds the storage for its own pass records, so the
/// fee never enters the reserve and the contract's float isn't drained.
#[test]
fn gated_buy_pays_its_own_record_storage() {
    use near_contract_standards::storage_management::StorageManagement;
    let mut c = init(Some(launch()));
    let reg = c.storage_balance_bounds().min.as_yoctonear();
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    buy_with(&mut c, ALICE, T_START, ONE_NEAR, &p, &sign(VERIFIER_SEED, &p));
    let liquid: u128 = serde_json::to_value(c.brain_stats()).unwrap()["liquid"].as_str().unwrap().parse().unwrap();
    assert_eq!(liquid, ONE_NEAR - reg - PASS_STORAGE_FEE);
}

#[test]
fn gated_buy_must_cover_the_pass_fee() {
    let mut c = init(Some(launch()));
    let p = pass(ALICE, 0, E0_CAP, T_E0_END, &nonce(1));
    let s = sign(VERIFIER_SEED, &p);
    expect_panic(|| { buy_with(&mut c, ALICE, T_START, PASS_STORAGE_FEE, &p, &s); }, "DepositBelowStorageCost");
}
