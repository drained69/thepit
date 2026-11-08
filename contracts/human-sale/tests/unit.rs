//! Host-side unit tests for `human-sale` (mocked blockchain env).
//! Run with: cargo test --features unit-tests
//!
//! Covers the frozen spec in docs/02-mechanics.md:
//!   happy path · spoofed verifier · stolen pass (wrong buyer) · replay ·
//!   expiry · wrong epoch · wrong deposit · pass cap · per-buyer cap ·
//!   unknown verifier · pause · open phase ("bot tax") · revoke.

#![cfg(feature = "unit-tests")]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use human_sale::{EpochConfig, OpenConfig, PassToken, ATOMS_PER_TOKEN};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, NearToken};
use serde_json::json;

const SALE: &str = "sale.near";
const OWNER: &str = "owner.near";
const ALICE: &str = "alice.near";
const BOB: &str = "bob.near";
const BOT: &str = "sniper-bot.near";

/// Deterministic verifier seed for tests (NOT a production key).
const VERIFIER_SEED: [u8; 32] = [7u8; 32];
const OTHER_SEED: [u8; 32] = [13u8; 32];

/// Epoch timeline in milliseconds.
const T_INIT: u64 = 500; // before sale
const T_E0: u64 = 1_000; // epoch 0 active
const T_E1: u64 = 10_000; // epoch 1 active
const T_E2: u64 = 20_000; // epoch 2 active
const T_OPEN: u64 = 30_000; // open phase active
const T_AFTER: u64 = 40_000; // everything over

const PASS_TTL_MS: u64 = 600_000;

fn verifier_key() -> SigningKey {
    SigningKey::from_bytes(&VERIFIER_SEED)
}

fn epochs() -> Vec<EpochConfig> {
    vec![
        EpochConfig {
            starts_at_ms: T_E0,
            ends_at_ms: T_E1,
            price_yocto_per_token: 25_000_000_000_000_000, // 0.025 N / token
            per_buyer_max_tokens: 2_000_000,
            epoch_cap_tokens: 30_000_000,
        },
        EpochConfig {
            starts_at_ms: T_E1,
            ends_at_ms: T_E2,
            price_yocto_per_token: 30_000_000_000_000_000,
            per_buyer_max_tokens: 2_000_000,
            epoch_cap_tokens: 80_000_000,
        },
        EpochConfig {
            starts_at_ms: T_E2,
            ends_at_ms: T_OPEN,
            price_yocto_per_token: 50_000_000_000_000_000,
            per_buyer_max_tokens: 2_000_000,
            epoch_cap_tokens: 140_000_000,
        },
    ]
}

/// Open price = 3× the last epoch price (bot tax invariant).
fn open_cfg() -> OpenConfig {
    OpenConfig {
        ends_at_ms: T_AFTER,
        price_yocto_per_token: 150_000_000_000_000_000,
        per_buyer_max_tokens: 10_000_000,
        open_cap_tokens: 50_000_000,
    }
}

fn account(id: &str) -> AccountId {
    id.parse().unwrap()
}

/// Push a fresh mocked environment; storage persists across calls in a test.
fn env_as(predecessor: &str, now_ms: u64, attached_yocto: u128) {
    near_sdk::testing_env!(
        VMContextBuilder::new()
            .current_account_id(account(SALE))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .block_timestamp(now_ms * 1_000_000) // context ns → env ms
            .attached_deposit(NearToken::from_yoctonear(attached_yocto))
            .build()
    );
}

fn init_sale() -> human_sale::HumanSaleContract {
    env_as(OWNER, T_INIT, 0);
    human_sale::HumanSaleContract::new(
        account(OWNER),
        "HUMAN-001".into(),
        epochs(),
        open_cfg(),
        U128(1_000_000_000u128.checked_mul(ATOMS_PER_TOKEN).unwrap()),
        70, // 30% sale, 70% treasury
        "HUMAN".into(),
        "HUMAN".into(),
        24,
        None,
        None,
    )
}

fn register_verifier(contract: &mut human_sale::HumanSaleContract) {
    env_as(OWNER, T_INIT, 0);
    let vk = verifier_key().verifying_key();
    contract.register_verifier(hex::encode(vk.as_bytes()), "test-tee".into(), "deadbeef".repeat(8));
}

/// Register an FT account (registration_only → refund excess).
fn register_ft(contract: &mut human_sale::HumanSaleContract, who: &str) {
    env_as(who, T_INIT, 125_000_000_000_000_000_000_000_000); // 0.125 N
    contract.storage_deposit(Some(account(who)), Some(true));
}

/// Canonical pass JSON matching the frozen spec (docs/02-mechanics.md).
fn pass_json(buyer: &str, epoch: u32, max_tokens: u128, now: u64, nonce: &str) -> String {
    json!({
        "v": 1,
        "sale": "HUMAN-001",
        "kind": "human",
        "buyer": buyer,
        "epoch": epoch,
        "max_amount": max_tokens.to_string(),
        "nonce": nonce,
        "expires_at_ms": now + PASS_TTL_MS,
    })
    .to_string()
}

fn sign(pass: &str, sk: &SigningKey) -> String {
    B64.encode(sk.sign(pass.as_bytes()).to_bytes())
}

fn deposit_for(tokens: u128, price_yocto_per_token: u128) -> u128 {
    tokens * price_yocto_per_token
}

// ————————————————————————————— tests —————————————————————————————

#[test]
fn init_mints_treasury_only() {
    let sale = init_sale();
    let overview = sale.sale_overview();
    assert_eq!(overview["sale_id"], "HUMAN-001");
    assert_eq!(overview["phase"], "pre");
    assert_eq!(
        overview["total_supply"],
        (1_000_000_000u128 * ATOMS_PER_TOKEN).to_string()
    );
    let owner_balance: u128 = sale.ft_balance_of(account(OWNER)).0;
    // 70% treasury pre-mint.
    assert_eq!(owner_balance, 700_000_000u128 * ATOMS_PER_TOKEN);
}

#[test]
fn happy_path_human_purchase() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    assert_eq!(
        sale.sale_overview()["sale_id"],
        "HUMAN-001"
    );
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"aa11".repeat(16));
    let sig = sign(&pass, &sk);
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);

    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass.clone(), sig.clone());

    assert_eq!(sale.ft_balance_of(account(ALICE)).0, 1_000_000u128 * ATOMS_PER_TOKEN);
    assert!(sale.pass_used(pass));
    let buyer = sale.buyer_state(account(ALICE));
    assert_eq!(
        buyer["per_phase"][0]["bought"],
        (1_000_000u128 * ATOMS_PER_TOKEN).to_string()
    );
    let overview = sale.sale_overview();
    assert_eq!(overview["phase"], "human");

    // Second purchase by the SAME verifier key & new nonce works.
    let pass2 = pass_json(ALICE, 0, 1_000_000, T_E0, &"bb22".repeat(16));
    let sig2 = sign(&pass2, &sk);
    env_as(ALICE, T_E0 + 2, deposit);
    sale.purchase(pass2, sig2);
}

#[test]
fn open_phase_is_after_human_epochs() {
    env_as(OWNER, T_INIT, 0);
    let sale = init_sale();
    let overview = sale.sale_overview();
    assert_eq!(overview["sale_id"], "HUMAN-001");
    // sanity: phase label logic exists; deeper open-phase behavior covered below
    assert_eq!(overview["phase"], "pre");
}

#[test]
#[should_panic(expected = "PassUnknownVerifier")]
fn rejects_signature_of_unknown_key() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let rogue = SigningKey::from_bytes(&OTHER_SEED);
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"cc33".repeat(16));
    let sig = sign(&pass, &rogue); // signed by a key that is NOT registered

    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);
    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
#[should_panic(expected = "PassNotForYou")]
fn rejects_stolen_pass_from_other_account() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);
    register_ft(&mut sale, BOT);

    let sk = verifier_key();
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"dd44".repeat(16));
    let sig = sign(&pass, &sk);

    // The bot replays ALICE's captured pass with the BOT's own deposit.
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);
    env_as(BOT, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
#[should_panic(expected = "PassReplay")]
fn rejects_pass_replay() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"ee55".repeat(16));
    let sig = sign(&pass, &sk);
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);

    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass.clone(), sig.clone());

    env_as(ALICE, T_E0 + 2, deposit);
    sale.purchase(pass, sig); // same pass bytes again
}

#[test]
#[should_panic(expected = "PassExpired")]
fn rejects_expired_pass() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    // A pass signed when its expiry has already passed: expires_at_ms < now.
    let pass = json!({
        "v": 1,
        "sale": "HUMAN-001",
        "kind": "human",
        "buyer": ALICE,
        "epoch": 0,
        "max_amount": "1000000",
        "nonce": "ff66".repeat(16),
        "expires_at_ms": T_E0, // purchase happens at T_E0 + 1 → expired
    })
    .to_string();
    let sig = sign(&pass, &sk);
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);

    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
#[should_panic(expected = "EpochClosedOrFuture")]
fn rejects_pass_for_wrong_epoch() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    // Pass says epoch 1 but we buy during epoch 0.
    let pass = pass_json(ALICE, 1, 1_000_000, T_E0, &"aa77".repeat(16));
    let sig = sign(&pass, &sk);

    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);
    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
#[should_panic(expected = "PassExceedsAmount")]
fn rejects_amount_over_pass_cap() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    // Pass allows only 100 tokens; deposit buys 1,000,000.
    let pass = pass_json(ALICE, 0, 100, T_E0, &"aa88".repeat(16));
    let sig = sign(&pass, &sk);

    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);
    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
#[should_panic(expected = "WrongAttachedDeposit")]
fn rejects_deposit_not_matching_price() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"aa99".repeat(16));
    let sig = sign(&pass, &sk);

    // Deposit = price×1M minus one yocto → not an exact price multiple.
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000) - 1;
    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
fn per_buyer_cap_enforced_across_purchases() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    let sk = verifier_key();
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);

    // per-buyer cap = 2M tokens → two 1M purchases succeed, the third fails.
    for i in 0..2 {
        let nonce = format!("{:064x}", i);
        let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &nonce);
        let sig = sign(&pass, &sk);
        env_as(ALICE, T_E0 + 1 + i, deposit);
        sale.purchase(pass, sig);
    }
    let balance = sale.ft_balance_of(account(ALICE)).0;
    assert_eq!(balance, 2_000_000u128 * ATOMS_PER_TOKEN);

    // Third purchase over the cap.
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"99ca".repeat(16));
    let sig = sign(&pass, &sk);
    env_as(ALICE, T_E0 + 5, deposit);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        sale.purchase(pass, sig)
    }));
    let msg = res
        .unwrap_err()
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(msg.contains("PerBuyerCap"), "panic was: {msg}");
}

#[test]
#[should_panic(expected = "SalePaused")]
fn paused_sale_rejects_purchase() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    env_as(OWNER, T_INIT, 0);
    sale.set_paused(true);

    let sk = verifier_key();
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"papa".repeat(16));
    let sig = sign(&pass, &sk);
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);

    env_as(ALICE, T_E0 + 1, deposit);
    sale.purchase(pass, sig);
}

#[test]
fn open_phase_anyone_can_buy_at_bot_tax_price() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, BOT);

    // Open phase: no pass needed.
    let deposit = deposit_for(500_000, 150_000_000_000_000_000);
    env_as(BOT, T_OPEN + 1, deposit);
    sale.purchase_open_phase();
    assert_eq!(sale.ft_balance_of(account(BOT)).0, 500_000u128 * ATOMS_PER_TOKEN);
}

#[test]
#[should_panic(expected = "OpenPhaseNotStartedOrEnded")]
fn open_phase_rejects_purchase_before_open() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, BOT);

    let deposit = deposit_for(500_000, 150_000_000_000_000_000);
    env_as(BOT, T_E0 + 1, deposit); // still human epoch
    sale.purchase_open_phase();
}

#[test]
fn revoked_verifier_cannot_sign_more_passes() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);
    register_ft(&mut sale, ALICE);

    env_as(OWNER, T_INIT, 0);
    let vk = verifier_key().verifying_key();
    sale.revoke_verifier(hex::encode(vk.as_bytes()));

    let sk = verifier_key();
    let pass = pass_json(ALICE, 0, 1_000_000, T_E0, &"rr00".repeat(16));
    let sig = sign(&pass, &sk);
    let deposit = deposit_for(1_000_000, 25_000_000_000_000_000);
    env_as(ALICE, T_E0 + 1, deposit);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        sale.purchase(pass, sig)
    }));
    let msg = res
        .unwrap_err()
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(msg.contains("PassUnknownVerifier"), "panic was: {msg}");
}

#[test]
fn finalize_only_after_open_ends() {
    env_as(OWNER, T_INIT, 0);
    let mut sale = init_sale();
    register_verifier(&mut sale);

    // Too early.
    env_as(OWNER, T_OPEN, 0);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        sale.finalize_sale()
    }));
    let msg = res
        .unwrap_err()
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(msg.contains("OpenPhaseMustEndFirst"), "panic was: {msg}");

    // After open ends: finalizes.
    env_as(OWNER, T_AFTER + 1, 0);
    sale.finalize_sale();
    assert!(sale.sale_overview()["finalized"].as_bool().unwrap());
}

#[test]
fn pass_json_roundtrip_matches_contract_types() {
    env_as(OWNER, T_INIT, 0);
    let raw = pass_json(BOB, 2, 123_456_789_123_456_789u128, T_E2, &("00ff".repeat(16) + "oops"));
    let parsed: PassToken = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.v, 1);
    assert_eq!(parsed.sale, "HUMAN-001");
    assert_eq!(parsed.kind, "human");
    assert_eq!(parsed.buyer.to_string(), BOB);
    assert_eq!(parsed.epoch, 2);
    assert_eq!(parsed.max_amount, "123456789123456789");
    assert_eq!(parsed.expires_at_ms, T_E2 + PASS_TTL_MS);
}

#[test]
fn epoch_json_deser_numbers_required() {
    let j = r#"{"starts_at_ms":1793770180000,"ends_at_ms":1793770900000,"price_yocto_per_token":20000000000000000,"per_buyer_max_tokens":2000000,"epoch_cap_tokens":30000000}"#;

    // Regression: near-sdk 5.x JSON deserializes u128 args from JSON NUMBERS,
    // NOT strings ("invalid number" otherwise). deploy.mjs + integration tests
    // must send numbers for price/caps; U128 top-level stays a string.
    let e: Result<EpochConfig, _> = serde_json::from_str(j);
    assert!(e.is_ok(), "u128 fields must deserialize from numbers: {e:?}");
}
