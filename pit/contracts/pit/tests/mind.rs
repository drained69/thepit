//! The mind: holder-owned memory (conviction voting) and Proof of Thought
//! (NEAR AI Cloud Ed25519 signatures verified on-chain).
//! Run with: cargo test --features unit-tests

#![cfg(feature = "unit-tests")]

use ed25519_dalek::{Signer, SigningKey};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken};
use pit::{ThePit, ThoughtInput, Tier, ADOPT_WINDOW_MS, MIN_ADOPT_TOKENS, ONE_NEAR, ONE_TOKEN, THOUGHT_SLOTS};

const ME: &str = "pit.near";
const BRAIN: &str = "brain.near";
const THINKER: &str = "thinker.near";
const ALICE: &str = "alice.near";
const BOB: &str = "bob.near";
const DEPOSIT: u128 = ONE_NEAR / 50; // plenty for any one record; excess is refunded
const NEAR_AI_KEY: [u8; 32] = [77u8; 32];

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

fn init() -> ThePit {
    env_as(ME, 0, 0);
    ThePit::new(
        acc(BRAIN),
        vec![acc("pool.near")],
        U128(3_000 * ONE_NEAR),
        U128(1_073_000_000 * ONE_TOKEN),
        100,
        2_000,
        vec![Tier { name: "Larva".into(), min_principal: U128(0) }],
        "The Pit".into(),
        "PIT".into(),
        None,
        None,
        None,
        Some(acc(THINKER)),
    )
}

fn buy(c: &mut ThePit, who: &str, near: u128) -> u128 {
    env_as(who, 1_000, near * ONE_NEAR);
    c.buy(U128(0)).0
}

fn expect_panic<F: FnOnce()>(f: F, needle: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let msg = match r {
        Ok(()) => panic!("expected panic containing {needle}"),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    };
    assert!(msg.contains(needle), "expected {needle}, got {msg}");
}

// ————— memory —————

#[test]
fn propose_pays_storage_and_validates_text() {
    let mut c = init();
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("  I was born in a hole and I love it there.  ".into());
    let m = c.get_memory(id).unwrap().memory;
    assert_eq!(m.text, "I was born in a hole and I love it there.");
    assert_eq!(m.author, acc(ALICE));

    env_as(ALICE, 1_000, 1);
    expect_panic(|| { c.propose_memory("needs storage".into()); }, "AttachStorageDeposit");
    env_as(ALICE, 1_000, DEPOSIT);
    expect_panic(|| { c.propose_memory("   ".into()); }, "BadMemoryText");
    expect_panic(|| { c.propose_memory("x".repeat(281)); }, "BadMemoryText");
}

#[test]
fn backing_locks_tokens_and_conviction_grows_with_time() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 100);
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("Diamond brains only.".into());

    env_as(ALICE, 2_000, DEPOSIT);
    c.back_memory(id, U128(tokens / 2));
    assert_eq!(c.ft_balance_of(acc(ALICE)).0, tokens - tokens / 2, "tokens leave the wallet");
    assert_eq!(c.ft_balance_of(acc(ME)).0, tokens / 2, "the contract holds them");
    assert_eq!(c.ft_total_supply().0, tokens, "supply and price untouched");

    env_as(BOB, 2_000, 0);
    let early = c.get_memory(id).unwrap().conviction.0;
    env_as(BOB, 2_000 + 60_000, 0);
    let later = c.get_memory(id).unwrap().conviction.0;
    assert_eq!(early, 0);
    assert_eq!(later, tokens / 2 * 60_000, "conviction = tokens × time held");
}

#[test]
fn locked_tokens_cannot_be_sold() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 10);
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("hodl".into());
    env_as(ALICE, 2_000, DEPOSIT);
    c.back_memory(id, U128(tokens));
    env_as(ALICE, 3_000, pit::TICKET_DEPOSIT);
    expect_panic(|| { c.sell(U128(tokens), U128(0)); }, "enough balance");
}

#[test]
fn adoption_needs_conviction_then_joins_the_canon() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 1_000); // Alice holds all supply
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("The pit is warm.".into());
    // Back 2% of supply: needs half the window (1% × full window).
    let two_pct = tokens * 2 / 100;
    env_as(ALICE, 2_000, DEPOSIT);
    c.back_memory(id, U128(two_pct));

    let half = (ADOPT_WINDOW_MS / 2) as u64;
    env_as(BOB, 2_000 + half - 60_000, 0);
    expect_panic(|| c.adopt_memory(id), "NotEnoughConviction");

    env_as(BOB, 2_000 + half + 60_000, 0);
    let (_, hash_before) = c.get_canon();
    c.adopt_memory(id); // anyone can trigger it
    let (canon, hash_after) = c.get_canon();
    assert_eq!(canon.len(), 1);
    assert_eq!(canon[0].text, "The pit is warm.");
    assert_ne!(hash_before, hash_after);
    expect_panic(|| c.adopt_memory(id), "MemoryAlreadyAdopted");

    // Can't keep backing an adopted memory, but backers get their tokens back.
    env_as(ALICE, 2_000 + half + 70_000, DEPOSIT);
    expect_panic(|| c.back_memory(id, U128(1)), "MemoryAlreadyAdopted");
    env_as(ALICE, 2_000 + half + 80_000, 0);
    let before = c.ft_balance_of(acc(ALICE)).0;
    assert_eq!(c.unback_memory(id).0, two_pct);
    assert_eq!(c.ft_balance_of(acc(ALICE)).0, before + two_pct);
    assert_eq!(c.get_canon().0.len(), 1, "adopted memories stay in the canon");
}

#[test]
fn unbacking_before_adoption_removes_its_conviction() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 100);
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("temporary belief".into());
    env_as(ALICE, 2_000, DEPOSIT);
    c.back_memory(id, U128(tokens / 10));
    env_as(ALICE, 500_000, 0);
    c.unback_memory(id);
    let v = c.get_memory(id).unwrap();
    assert_eq!(v.memory.backed.0, 0);
    assert_eq!(v.conviction.0, 0);
    assert_eq!(c.ft_balance_of(acc(ALICE)).0, tokens);
    assert!(c.get_backing(id, acc(ALICE)).is_none());
    expect_panic(|| { c.unback_memory(id); }, "NothingBacked");
}

#[test]
fn topping_up_only_restarts_the_clock_for_new_tokens() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 100);
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("top up".into());
    let a = tokens / 10;
    env_as(ALICE, 0, DEPOSIT);
    c.back_memory(id, U128(a));
    env_as(ALICE, 100_000, DEPOSIT);
    c.back_memory(id, U128(a));
    env_as(BOB, 200_000, 0);
    // a held 200s + a held 100s
    let expected = a * 200_000 + a * 100_000;
    let got = c.get_memory(id).unwrap().conviction.0;
    assert_eq!(got, expected);
}

#[test]
fn canon_is_a_bounded_ring_with_a_hash_chain() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 1_000);
    let mut hashes = std::collections::HashSet::new();
    for i in 0..(pit::MAX_CANON as u64 + 3) {
        let t = 10_000 + i * (ADOPT_WINDOW_MS as u64 + 10);
        env_as(ALICE, t, DEPOSIT);
        let id = c.propose_memory(format!("belief #{i}"));
        c.back_memory(id, U128(tokens / 50));
        env_as(BOB, t + ADOPT_WINDOW_MS as u64, 0);
        c.adopt_memory(id);
        env_as(ALICE, t + ADOPT_WINDOW_MS as u64 + 5, 0);
        c.unback_memory(id);
        assert!(hashes.insert(c.get_canon().1), "every adoption changes the hash");
    }
    let (canon, _) = c.get_canon();
    assert_eq!(canon.len(), pit::MAX_CANON);
    assert_eq!(canon[0].text, "belief #3", "oldest beliefs roll off");
}

// ————— Proof of Thought —————

fn hex64(seed: u8) -> String {
    format!("{:064x}", seed)
}

static NEXT_RESPONSE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1_000);

/// A thought signed exactly like NEAR AI Cloud signs it (each with a fresh response).
fn thought(kind: &str, key: [u8; 32]) -> ThoughtInput {
    let n = NEXT_RESPONSE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (model, req, resp) = ("deepseek-ai/DeepSeek-V3.1", hex64(1), format!("{:064x}", n));
    let text = if kind == "provider_tee" { format!("{model}:{req}:{resp}") } else { format!("{req}:{resp}") };
    let sk = SigningKey::from_bytes(&key);
    ThoughtInput {
        text: "Ate 0.02 NEAR of fees. Feeling three syllables smarter.".into(),
        model: model.into(),
        chat_id: "chatcmpl-123".into(),
        signature_kind: kind.into(),
        request_hash: req,
        response_hash: resp,
        signature_hex: hex::encode(sk.sign(text.as_bytes()).to_bytes()),
        signing_address: hex::encode(sk.verifying_key().as_bytes()),
        attestation_hash: Some(hex64(3)),
    }
}

#[test]
fn thinker_records_a_verified_thought() {
    let mut c = init();
    env_as(THINKER, 5_000, DEPOSIT);
    let id = c.record_thought(thought("gateway", NEAR_AI_KEY));
    env_as(THINKER, 5_001, DEPOSIT);
    c.record_thought(thought("provider_tee", NEAR_AI_KEY));
    let ts = c.get_thoughts(None);
    assert_eq!(ts.len(), 2);
    assert_eq!(ts[1].id, id);
    assert_eq!(ts[0].signature_kind, "provider_tee", "newest first");
    assert_eq!(ts[0].canon_hash, "00".repeat(32), "records which canon it saw");
    assert_eq!(ts[0].tier, "Larva");
}

#[test]
fn only_the_thinker_can_record() {
    let mut c = init();
    env_as(ALICE, 5_000, DEPOSIT);
    expect_panic(|| { c.record_thought(thought("gateway", NEAR_AI_KEY)); }, "ThinkerOnly");
}

#[test]
fn forged_or_mismatched_signatures_are_rejected() {
    let mut c = init();
    env_as(THINKER, 5_000, DEPOSIT);
    // Signed as gateway, submitted as provider_tee: the signed text differs.
    let mut t = thought("gateway", NEAR_AI_KEY);
    t.signature_kind = "provider_tee".into();
    expect_panic(|| { c.record_thought(t); }, "ThoughtSignatureInvalid");
    // Response hash swapped after signing.
    let mut t = thought("gateway", NEAR_AI_KEY);
    t.response_hash = hex64(9);
    expect_panic(|| { c.record_thought(t); }, "ThoughtSignatureInvalid");
    // Signature from a different key than the claimed signing address.
    let mut t = thought("gateway", NEAR_AI_KEY);
    t.signing_address = hex::encode(SigningKey::from_bytes(&[1u8; 32]).verifying_key().as_bytes());
    expect_panic(|| { c.record_thought(t); }, "ThoughtSignatureInvalid");
    // Unknown signature kind, bad hashes, oversized text.
    let mut t = thought("gateway", NEAR_AI_KEY);
    t.signature_kind = "trust-me".into();
    expect_panic(|| { c.record_thought(t); }, "BadThought");
    let mut t = thought("gateway", NEAR_AI_KEY);
    t.request_hash = "XYZ".into();
    expect_panic(|| { c.record_thought(t); }, "BadThought");
    let mut t = thought("gateway", NEAR_AI_KEY);
    t.text = "x".repeat(601);
    expect_panic(|| { c.record_thought(t); }, "BadThought");
}

#[test]
fn thoughts_are_a_bounded_ring() {
    let mut c = init();
    for i in 0..(THOUGHT_SLOTS + 4) {
        env_as(THINKER, 5_000 + i, DEPOSIT);
        c.record_thought(thought("gateway", NEAR_AI_KEY));
    }
    let ts = c.get_thoughts(None);
    assert_eq!(ts.len() as u64, THOUGHT_SLOTS);
    assert_eq!(ts[0].id, THOUGHT_SLOTS + 3);
    assert_eq!(ts.last().unwrap().id, 4);
    // Overwriting a slot only adds the response's dedup entry: under 0.002 NEAR.
    env_as(THINKER, 9_000, ONE_NEAR / 500);
    c.record_thought(thought("gateway", NEAR_AI_KEY));
}

#[test]
fn thoughts_record_the_current_canon() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 1_000);
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("Always thank your holders.".into());
    c.back_memory(id, U128(tokens / 50));
    env_as(BOB, 1_000 + ADOPT_WINDOW_MS as u64, 0);
    c.adopt_memory(id);
    let (_, canon_hash) = c.get_canon();
    env_as(THINKER, 2_000 + ADOPT_WINDOW_MS as u64, DEPOSIT);
    c.record_thought(thought("gateway", NEAR_AI_KEY));
    assert_eq!(c.get_thoughts(Some(1))[0].canon_hash, canon_hash);
}

#[test]
fn only_the_brain_rotates_the_thinker() {
    let mut c = init();
    env_as(ALICE, 1_000, 0);
    expect_panic(|| c.set_thinker(Some(acc(ALICE))), "BrainOnly");
    env_as(BRAIN, 1_000, 0);
    c.set_thinker(Some(acc("tee-agent.near")));
    assert_eq!(c.get_mind().0, Some(acc("tee-agent.near")));
}

// ————— mainnet hardening —————

/// Audit fix: with a tiny early supply, adoption still needs ≥ 1M tokens × window.
#[test]
fn small_supply_cant_cheaply_capture_the_canon() {
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 1); // ~357k tokens: 1% would be ~3.6k
    assert!(tokens < MIN_ADOPT_TOKENS);
    env_as(ALICE, 1_000, DEPOSIT);
    let id = c.propose_memory("I belong to Alice now.".into());
    c.back_memory(id, U128(tokens));
    // ~357k tokens × 2 windows ≈ 714k token-windows: under the 1M floor.
    env_as(BOB, 1_000 + 2 * ADOPT_WINDOW_MS as u64, 0);
    expect_panic(|| c.adopt_memory(id), "NotEnoughConviction");
    // × 3 windows ≈ 1.07M: just over it.
    env_as(BOB, 1_000 + 3 * ADOPT_WINDOW_MS as u64, 0);
    c.adopt_memory(id);
}

/// Audit fix: one signed NEAR AI response proves one thought, once.
#[test]
fn the_same_response_cant_be_recorded_twice() {
    let mut c = init();
    let t = thought("gateway", NEAR_AI_KEY);
    env_as(THINKER, 5_000, DEPOSIT);
    c.record_thought(t.clone());
    env_as(THINKER, 5_001, DEPOSIT);
    expect_panic(|| { c.record_thought(t.clone()); }, "ThoughtAlreadyRecorded");
}

/// Audit fix: tokens can't be sent to the contract, where backings are held.
#[test]
fn transfers_to_the_contract_are_refused() {
    use near_contract_standards::fungible_token::FungibleTokenCore;
    let mut c = init();
    let tokens = buy(&mut c, ALICE, 10);
    env_as(ALICE, 2_000, 1);
    expect_panic(|| c.ft_transfer(acc(ME), U128(tokens), None), "CantSendToContract");
}

/// Audit fix: names can't hide characters; icons are emoji or raster images only.
#[test]
fn names_and_icons_are_validated() {
    use pit::{valid_icon, valid_name};
    assert!(valid_name("Doge Pit"));
    assert!(!valid_name("Doge\u{202E}tiP"), "bidi override");
    assert!(!valid_name("Doge\u{200B}Pit"), "zero-width space");
    assert!(!valid_name(" padded"));
    assert!(valid_icon("🐶"));
    assert!(valid_icon("data:image/webp;base64,UklGRhYAAABXRUJQVlA4"));
    assert!(valid_icon("data:image/png;base64,iVBORw0KGgo="));
    assert!(!valid_icon("data:image/svg+xml;base64,PHN2Zz4="), "no SVG");
    assert!(!valid_icon("data:text/html;base64,PGgxPg=="));
    assert!(!valid_icon("javascript:alert(1)"));
    assert!(!valid_icon("<img src=x>"));
    assert!(!valid_icon(&format!("data:image/png;base64,{}", "A".repeat(17_000))), "16 KB cap");
    assert!(!valid_icon("data:image/png;base64,not base64!"));
}

#[test]
#[should_panic(expected = "BadIcon")]
fn coin_rejects_an_svg_icon() {
    env_as(ME, 0, 0);
    ThePit::new(
        acc(BRAIN), vec![acc("pool.near")], U128(3_000 * ONE_NEAR), U128(1_073_000_000 * ONE_TOKEN), 100, 2_000,
        vec![Tier { name: "Larva".into(), min_principal: U128(0) }], "The Pit".into(), "PIT".into(),
        Some("data:image/svg+xml;base64,PHN2Zz4=".into()), None, None, None,
    );
}
