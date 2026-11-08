//! Shade Agent pass tests: the signer is an implicit account (its id is its
//! Ed25519 key) and the agent contract decides whether it's a valid, attested
//! agent. The callback is driven directly with each possible registry answer.
//! Run with: cargo test --features unit-tests

#![cfg(feature = "unit-tests")]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use pit::{AgentCheck, AgentValidity, GatedEpoch, ThePit, LaunchConfig, Tier, ONE_NEAR, ONE_TOKEN};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, NearToken, PromiseError};
use serde_json::json;

const ME: &str = "pit.near";
const REGISTRY: &str = "agent.shade.near";
const ALICE: &str = "alice.near";
const SALE: &str = "PIT-001";
const T_START: u64 = 1_000;
const T_END: u64 = 10_000;
const AGENT_SEED: [u8; 32] = [21u8; 32];

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

/// The agent's account id = hex of its public key, as shade-agent-js derives it.
fn agent_id(seed: [u8; 32]) -> AccountId {
    hex::encode(SigningKey::from_bytes(&seed).verifying_key().as_bytes()).parse().unwrap()
}

fn init(registry: Option<&str>) -> ThePit {
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
        Some(LaunchConfig {
            sale_id: SALE.into(),
            starts_at_ms: T_START,
            gated_epochs: vec![GatedEpoch { ends_at_ms: T_END, per_buyer_max_tokens: U128(2_000_000) }],
            verifiers: vec![],
            agent_registry: registry.map(acc),
        }),
        None,
        None,
    )
}

fn pass(buyer: &str, max_tokens: u128, nonce: u8) -> String {
    json!({
        "v": 1, "sale": SALE, "kind": "human", "buyer": buyer, "epoch": 0,
        "max_amount": max_tokens.to_string(), "nonce": format!("{:064x}", nonce), "expires_at_ms": T_END,
    })
    .to_string()
}

fn sign(seed: [u8; 32], p: &str) -> String {
    B64.encode(SigningKey::from_bytes(&seed).sign(p.as_bytes()).to_bytes())
}

fn valid(id: &AccountId) -> Result<Option<AgentCheck>, PromiseError> {
    Ok(Some(AgentCheck { account_id: id.clone(), validity: AgentValidity::Valid }))
}

const DEPOSIT: u128 = ONE_NEAR / 10;

/// buy_with_agent_pass, then the callback with `answer`. Returns tokens out.
fn run(c: &mut ThePit, p: &str, answer: Result<Option<AgentCheck>, PromiseError>, callback_ms: u64, max: u128) -> u128 {
    let agent = agent_id(AGENT_SEED);
    env_as(ALICE, T_START, DEPOSIT);
    let _ = c.buy_with_agent_pass(p.into(), sign(AGENT_SEED, p), agent.clone(), U128(0));
    assert!(c.pass_used(p.into()), "pass is reserved while the check is in flight");
    env_as(ME, callback_ms, 0);
    let nullifier = env::sha256(p.as_bytes());
    let expires = serde_json::from_str::<serde_json::Value>(p).unwrap()["expires_at_ms"].as_u64().unwrap();
    let registration = c.get_refund_credit(acc(ALICE)).unwrap().storage_paid.0;
    c.on_agent_checked(acc(ALICE), U128(DEPOSIT - registration), nullifier, 0, U128(max * ONE_TOKEN), U128(0), agent, expires, answer).0
}

#[test]
fn pass_expiring_during_registry_call_is_refunded() {
    let mut c = init(Some(REGISTRY));
    let mut p: serde_json::Value = serde_json::from_str(&pass(ALICE, 2_000_000, 91)).unwrap();
    p["expires_at_ms"] = json!(T_START + 1);
    let p = p.to_string();
    let agent = agent_id(AGENT_SEED);
    assert_eq!(run(&mut c, &p, valid(&agent), T_START + 2, 2_000_000), 0);
    assert!(!c.pass_used(p));
}

fn expect_panic<F: FnOnce()>(f: F, needle: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let msg = match r {
        Ok(()) => panic!("expected panic containing {needle}"),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    };
    assert!(msg.contains(needle), "expected {needle}, got {msg}");
}

fn liquid(c: &ThePit) -> u128 {
    serde_json::to_value(c.brain_stats()).unwrap()["liquid"].as_str().unwrap().parse().unwrap()
}

#[test]
fn valid_attested_agent_pass_buys() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    let out = run(&mut c, &p, valid(&agent_id(AGENT_SEED)), T_START + 1, 250_000);
    assert!(out > 0);
    assert_eq!(c.ft_balance_of(acc(ALICE)).0, out);
    assert_eq!(c.gated_bought(acc(ALICE), 0).0, out);
    assert!(c.pass_used(p), "a settled pass stays used");
}

#[test]
fn invalid_agent_refunds_and_releases_pass() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    let id = agent_id(AGENT_SEED);
    let answer = Ok(Some(AgentCheck { account_id: id, validity: AgentValidity::Invalid }));
    assert_eq!(run(&mut c, &p, answer, T_START + 1, 250_000), 0);
    assert_eq!(c.ft_total_supply().0, 0);
    assert_eq!(liquid(&c), 0, "refunded NEAR never entered the reserve");
    assert!(!c.pass_used(p), "pass released so the buyer can retry with a valid gate");
}

#[test]
fn unregistered_agent_refunds() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    assert_eq!(run(&mut c, &p, Ok(None), T_START + 1, 250_000), 0);
    assert_eq!(c.ft_total_supply().0, 0);
}

#[test]
fn unreachable_registry_refunds() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    assert_eq!(run(&mut c, &p, Err(PromiseError::Failed), T_START + 1, 250_000), 0);
    assert_eq!(c.ft_total_supply().0, 0);
}

#[test]
fn registry_answer_for_another_account_is_rejected() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    let answer = Ok(Some(AgentCheck { account_id: acc("someone-else.near"), validity: AgentValidity::Valid }));
    assert_eq!(run(&mut c, &p, answer, T_START + 1, 250_000), 0);
}

#[test]
fn epoch_ending_mid_check_refunds() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    assert_eq!(run(&mut c, &p, valid(&agent_id(AGENT_SEED)), T_END + 1, 250_000), 0);
    assert_eq!(c.ft_total_supply().0, 0);
}

#[test]
fn cap_exceeded_in_callback_refunds() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 10, 1); // 10 tokens max; 0.1 NEAR buys ~35k
    assert_eq!(run(&mut c, &p, valid(&agent_id(AGENT_SEED)), T_START + 1, 10), 0);
    assert_eq!(c.ft_total_supply().0, 0);
    assert!(!c.pass_used(p));
}

#[test]
fn pass_cannot_be_double_spent_while_check_is_in_flight() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    let agent = agent_id(AGENT_SEED);
    env_as(ALICE, T_START, DEPOSIT);
    let _ = c.buy_with_agent_pass(p.clone(), sign(AGENT_SEED, &p), agent.clone(), U128(0));
    env_as(ALICE, T_START + 1, DEPOSIT);
    expect_panic(|| { let _ = c.buy_with_agent_pass(p.clone(), sign(AGENT_SEED, &p), agent.clone(), U128(0)); }, "PassReplay");
}

#[test]
fn signature_must_match_the_named_agent() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    env_as(ALICE, T_START, DEPOSIT);
    // Signed by a different key than the agent account named.
    expect_panic(|| { let _ = c.buy_with_agent_pass(p.clone(), sign([9u8; 32], &p), agent_id(AGENT_SEED), U128(0)); }, "PassUnknownVerifier");
}

#[test]
fn agent_must_be_an_implicit_account() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    env_as(ALICE, T_START, DEPOSIT);
    expect_panic(|| { let _ = c.buy_with_agent_pass(p.clone(), sign(AGENT_SEED, &p), acc("gate.near"), U128(0)); }, "AgentNotImplicitAccount");
}

#[test]
fn stolen_agent_pass_is_rejected() {
    let mut c = init(Some(REGISTRY));
    let p = pass(ALICE, 250_000, 1);
    env_as("bot.near", T_START, DEPOSIT);
    expect_panic(|| { let _ = c.buy_with_agent_pass(p.clone(), sign(AGENT_SEED, &p), agent_id(AGENT_SEED), U128(0)); }, "PassNotForYou");
}

#[test]
#[should_panic(expected = "BadConfig")]
fn launch_needs_a_verifier_or_a_registry() {
    init(None);
}

#[test]
fn snipers_still_get_nothing() {
    let mut c = init(Some(REGISTRY));
    env_as("bot.near", T_START, ONE_NEAR);
    expect_panic(|| { c.buy(U128(0)); }, "PassRequired");
}

/// The registry's real JSON shapes parse into AgentValidity without serde_json::Value.
#[test]
fn registry_validity_json_shapes_parse() {
    let v: AgentCheck = serde_json::from_str(r#"{"account_id":"abc.near","measurements":{"x":1},"ppid":"00","valid_until_ms":"5","validity":"Valid"}"#).unwrap();
    assert_eq!(v.validity, AgentValidity::Valid);
    let i: AgentCheck = serde_json::from_str(r#"{"account_id":"abc.near","validity":{"Invalid":["ExpiredAttestation","InvalidPpid"]}}"#).unwrap();
    assert_eq!(i.validity, AgentValidity::Invalid);
}
