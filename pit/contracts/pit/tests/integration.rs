//! Sandbox end-to-end: real The Pit wasm + mock staking pool, real receipts.
//! Proves the cross-contract callbacks and gas budgets actually work.
//!
//! Run: node pit/scripts/build.mjs && cargo test --features integration --test integration
//! (set NEAR_SANDBOX_BIN_PATH to reuse a cached sandbox binary offline)

#![cfg(feature = "integration")]

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const PIT_WASM: &str = "target/near/pit.wasm";
const POOL_WASM: &str = "../mock-pool/target/near/mock_pool.wasm";
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn n(v: &Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

async fn stats(c: &Contract) -> anyhow::Result<Value> {
    Ok(c.view("brain_stats").await?.json()?)
}

async fn keeper(who: &Account, c: &Contract, method: &str, args: Value) -> anyhow::Result<()> {
    let out = who
        .call(c.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(250))
        .transact()
        .await?;
    assert!(out.is_success(), "{method} failed: {:?}", out.failures());
    assert!(out.receipt_failures().is_empty(), "{method} receipt failed: {:?}", out.receipt_failures());
    Ok(())
}

/// `new` takes Borsh args: read the familiar JSON into the contract's own
/// types, then encode them in parameter order.
fn init_args(v: Value) -> Vec<u8> {
    use near_sdk::json_types::U128;
    use near_sdk::AccountId;
    #[derive(near_sdk::serde::Deserialize, near_sdk::borsh::BorshSerialize)]
    #[serde(crate = "near_sdk::serde")]
    #[borsh(crate = "near_sdk::borsh")]
    struct Init {
        brain: AccountId,
        pools: Vec<AccountId>,
        virtual_near: U128,
        virtual_tokens: U128,
        fee_bps: u16,
        buffer_bps: u16,
        tiers: Vec<pit::Tier>,
        name: String,
        symbol: String,
        icon: Option<String>,
        launch: Option<pit::LaunchConfig>,
        creator: Option<pit::CreatorCut>,
        thinker: Option<AccountId>,
    }
    near_sdk::borsh::to_vec(&serde_json::from_value::<Init>(v).expect("init json")).unwrap()
}

/// `record_thought` takes Borsh: read the JSON into the contract's type, encode it.
fn thought_args(v: Value) -> Vec<u8> {
    let t: pit::ThoughtInput = serde_json::from_value(v["thought"].clone()).expect("thought json");
    near_sdk::borsh::to_vec(&t).unwrap()
}

#[tokio::test]
async fn buy_stake_reward_harvest_sell() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;

    let pool = root
        .create_subaccount("pool")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?
        .deploy(&std::fs::read(POOL_WASM)?)
        .await?
        .into_result()?;
    pool.call("new").args_json(json!({ "unstake_delay_ms": 0 })).transact().await?.into_result()?;

    let pit = root
        .create_subaccount("pit")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?
        .deploy(&std::fs::read(PIT_WASM)?)
        .await?
        .into_result()?;
    let brain = root.create_subaccount("brain").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(500)).transact().await?.into_result()?;

    pit
        .call("new")
        .args(init_args(json!({
            "brain": brain.id(),
            "pools": [pool.id()],
            "virtual_near": (3_000 * NEAR).to_string(),
            "virtual_tokens": (1_073_000_000u128 * 1_000_000_000_000_000_000).to_string(),
            "fee_bps": 100,
            "buffer_bps": 2_000,
            "tiers": [{ "name": "Larva", "min_principal": "0" }, { "name": "Juvenile", "min_principal": (1_000 * NEAR).to_string() }],
            "name": "The Pit", "symbol": "PIT", "icon": null, "launch": null, "creator": null, "thinker": null
        })))
        .transact()
        .await?
        .into_result()?;

    // Alice buys with 100 NEAR.
    let out = alice
        .call(pit.id(), "buy")
        .args_json(json!({ "min_tokens_out": "0" }))
        .deposit(NearToken::from_near(100))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let tokens: String = out.json::<String>()?;
    let s = stats(&pit).await?;
    assert!(n(&s, "principal") > 98 * NEAR);

    // Keeper stakes the excess.
    keeper(&alice, &pit, "rebalance", json!({ "pool_index": 0 })).await?;
    let s = stats(&pit).await?;
    let staked = n(&s, "staked");
    assert!(staked > 70 * NEAR, "staked {staked}");
    let pool_view: Value = pool.view("get_account").args_json(json!({ "account_id": pit.id() })).await?.json()?;
    assert_eq!(n(&pool_view, "staked_balance"), staked);

    // Simulate a year of 5% yield.
    root.call(pool.id(), "add_rewards")
        .args_json(json!({ "account_id": pit.id() }))
        .deposit(NearToken::from_near(4))
        .transact()
        .await?
        .into_result()?;

    // rebalance #1 syncs and unstakes the rewards; #2 withdraws them.
    keeper(&alice, &pit, "rebalance", json!({ "pool_index": 0 })).await?;
    assert!(n(&stats(&pit).await?, "unstaking") > 3 * NEAR);
    keeper(&alice, &pit, "rebalance", json!({ "pool_index": 0 })).await?;
    assert_eq!(n(&stats(&pit).await?, "unstaking"), 0);

    // Harvest → brain gets rewards + fees (~4 + ~1 NEAR).
    let before = brain.view_account().await?.balance.as_yoctonear();
    keeper(&alice, &pit, "harvest", json!({})).await?;
    let gained = brain.view_account().await?.balance.as_yoctonear() - before;
    assert!(gained > 4 * NEAR && gained < 5 * NEAR + NEAR / 10, "brain gained {gained}");

    // Alice dumps everything: bigger than the buffer, so it queues.
    let r: Value = alice
        .call(pit.id(), "sell")
        .args_json(json!({ "amount": tokens, "min_near_out": "0" }))
        .deposit(NearToken::from_millinear(4)) // ticket deposit, returned with the payout
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .json()?;
    assert_eq!(r["status"], "queued");

    // Keeper unstakes, withdraws, pays the queue.
    keeper(&alice, &pit, "rebalance", json!({ "pool_index": 0 })).await?;
    keeper(&alice, &pit, "rebalance", json!({ "pool_index": 0 })).await?;
    let alice_before = alice.view_account().await?.balance.as_yoctonear();
    keeper(&brain, &pit, "process_queue", json!({ "max": 10 })).await?;
    let alice_got = alice.view_account().await?.balance.as_yoctonear() - alice_before;
    assert!(alice_got > 97 * NEAR, "alice got {alice_got}");

    let s = stats(&pit).await?;
    assert_eq!(n(&s, "queue_owed"), 0);
    assert_eq!(n(&s, "total_supply"), 0);
    Ok(())
}

/// Gated launch on a real chain: on-chain Ed25519 verify, sniper blocked,
/// stolen pass rejected, replay rejected. Uses a real launch-gate pass when
/// PIT_REAL_PASS points at the JSON written by scripts/get-pass.mjs for
/// buyer `alice.test.near`; otherwise signs one locally the way the gate does.
#[tokio::test]
async fn gated_launch_with_pass() -> anyhow::Result<()> {
    use base64::Engine;
    use ed25519_dalek::Signer;

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let bot = root.create_subaccount("bot").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;

    let (pass, sig_b64, signer_hex, source) = match std::env::var("PIT_REAL_PASS") {
        Ok(path) => {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
            (
                v["pass"].as_str().unwrap().to_string(),
                v["sig_b64"].as_str().unwrap().to_string(),
                v["verifier"]["signing_address"].as_str().unwrap().to_string(),
                "launch gate",
            )
        }
        Err(_) => {
            let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
            let pass = json!({
                "v": 1, "sale": "PIT-001", "kind": "early_access", "buyer": alice.id(), "epoch": 0,
                "max_amount": "250000", "nonce": "ab".repeat(32), "expires_at_ms": now_ms + 600_000,
            })
            .to_string();
            let sig = base64::engine::general_purpose::STANDARD.encode(key.sign(pass.as_bytes()).to_bytes());
            (pass, sig, hex::encode(key.verifying_key().as_bytes()), "local signer")
        }
    };
    println!("pass source: {source}");
    assert!(pass.contains(&format!("\"buyer\":\"{}\"", alice.id())), "pass must be for {}", alice.id());

    let pit = root
        .create_subaccount("pit")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?
        .deploy(&std::fs::read(PIT_WASM)?)
        .await?
        .into_result()?;
    pit
        .call("new")
        .args(init_args(json!({
            "brain": root.id(), "pools": ["pool.test.near"],
            "virtual_near": (3_000 * NEAR).to_string(),
            "virtual_tokens": (1_073_000_000u128 * 1_000_000_000_000_000_000).to_string(),
            "fee_bps": 100, "buffer_bps": 2_000,
            "tiers": [{ "name": "Larva", "min_principal": "0" }],
            "name": "The Pit", "symbol": "PIT", "icon": null,
            "launch": {
                "sale_id": "PIT-001",
                "starts_at_ms": now_ms - 60_000,
                "gated_epochs": [{ "ends_at_ms": now_ms + 3_600_000, "per_buyer_max_tokens": "2000000" }],
                "verifiers": [{ "pubkey_hex": signer_hex, "name": "pit-gate-sim-1", "evidence_hash_hex": "00".repeat(32) }],
                "agent_registry": null
            },
            "creator": null, "thinker": null
        })))
        .transact()
        .await?
        .into_result()?;

    let info: Value = pit.view("launch_info").await?.json()?;
    assert_eq!(info["phase"], "gated");

    // Sniper without a pass.
    let r = bot.call(pit.id(), "buy").args_json(json!({ "min_tokens_out": "0" }))
        .deposit(NearToken::from_near(10)).gas(Gas::from_tgas(50)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("PassRequired"), "{:?}", r.failures());

    // Sniper with Alice's pass.
    let r = bot.call(pit.id(), "buy_with_pass")
        .args_json(json!({ "pass": pass, "sig_b64": sig_b64, "min_tokens_out": "0" }))
        .deposit(NearToken::from_millinear(500)).gas(Gas::from_tgas(50)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("PassNotForYou"), "{:?}", r.failures());

    // Alice, with her pass: verified on-chain, minted on the curve.
    let r = alice.call(pit.id(), "buy_with_pass")
        .args_json(json!({ "pass": pass, "sig_b64": sig_b64, "min_tokens_out": "0" }))
        .deposit(NearToken::from_millinear(500)).gas(Gas::from_tgas(50)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let bal: String = pit.view("ft_balance_of").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    assert!(bal.parse::<u128>()? > 0);
    println!("alice bought {} PIT atoms with a {source} pass", bal);

    // Same pass again.
    let r = alice.call(pit.id(), "buy_with_pass")
        .args_json(json!({ "pass": pass, "sig_b64": sig_b64, "min_tokens_out": "0" }))
        .deposit(NearToken::from_millinear(100)).gas(Gas::from_tgas(50)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("PassReplay"), "{:?}", r.failures());
    Ok(())
}

/// Base58 for building a NEAR secret key string from raw bytes in tests.
fn bs58(bytes: &[u8]) -> String {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![];
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    std::iter::repeat('1').take(zeros).chain(digits.iter().rev().map(|&d| A[d as usize] as char)).collect()
}

/// Shade Agent path on a real chain: The Pit cross-calls the agent registry's
/// `get_agent` and only settles while the signer is a valid registered agent.
#[tokio::test]
async fn shade_agent_pass_is_checked_against_the_registry() -> anyhow::Result<()> {
    use base64::Engine;
    use ed25519_dalek::Signer;
    const REGISTRY_WASM: &str = "../mock-agent-registry/target/near/mock_agent_registry.wasm";

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;

    // The agent: an implicit account whose id is its public key.
    let agent_key = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
    let agent_hex = hex::encode(agent_key.verifying_key().as_bytes());
    let mut kp = agent_key.to_bytes().to_vec();
    kp.extend_from_slice(agent_key.verifying_key().as_bytes());
    let secret: near_workspaces::types::SecretKey = format!("ed25519:{}", bs58(&kp)).parse()?;
    let agent_id: near_workspaces::AccountId = agent_hex.parse()?;
    root.transfer_near(&agent_id, NearToken::from_near(1)).await?.into_result()?;
    let agent = near_workspaces::Account::from_secret_key(agent_id.clone(), secret, &worker);

    let registry = root.create_subaccount("registry").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?
        .deploy(&std::fs::read(REGISTRY_WASM)?).await?.into_result()?;
    registry.call("new").args_json(json!({ "owner_id": root.id(), "attestation_expiration_time_ms": "604800000" })).transact().await?.into_result()?;
    root.call(registry.id(), "whitelist_agent_for_local").args_json(json!({ "account_id": agent_id })).transact().await?.into_result()?;
    agent.call(registry.id(), "register_agent").args_json(json!({ "attestation": {} }))
        .deposit(NearToken::from_millinear(5)).transact().await?.into_result()?;

    let pit = root.create_subaccount("pit").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?
        .deploy(&std::fs::read(PIT_WASM)?).await?.into_result()?;
    pit.call("new").args(init_args(json!({
        "brain": root.id(), "pools": ["pool.test.near"],
        "virtual_near": (3_000 * NEAR).to_string(),
        "virtual_tokens": (1_073_000_000u128 * 1_000_000_000_000_000_000).to_string(),
        "fee_bps": 100, "buffer_bps": 2_000,
        "tiers": [{ "name": "Larva", "min_principal": "0" }],
        "name": "The Pit", "symbol": "PIT", "icon": null,
        "launch": {
            "sale_id": "PIT-001", "starts_at_ms": now_ms - 60_000,
            "gated_epochs": [{ "ends_at_ms": now_ms + 3_600_000, "per_buyer_max_tokens": "2000000" }],
            "verifiers": [], "agent_registry": registry.id()
        },
        "creator": null, "thinker": null
    }))).transact().await?.into_result()?;

    let make_pass = |nonce: u8, key: &ed25519_dalek::SigningKey| {
        let p = json!({
            "v": 1, "sale": "PIT-001", "kind": "early_access", "buyer": alice.id(), "epoch": 0,
            "max_amount": "250000", "nonce": format!("{:064x}", nonce), "expires_at_ms": now_ms + 600_000,
        }).to_string();
        let s = base64::engine::general_purpose::STANDARD.encode(key.sign(p.as_bytes()).to_bytes());
        (p, s)
    };
    let balance = |id: near_workspaces::AccountId| {
        let pit = pit.clone();
        async move { pit.view("ft_balance_of").args_json(json!({ "account_id": id })).await?.json::<String>().map(|s| s.parse::<u128>().unwrap()) }
    };
    let buy = |p: String, s: String, signer: String| {
        let alice = alice.clone();
        let pit = pit.clone();
        async move {
            alice.call(pit.id(), "buy_with_agent_pass")
                .args_json(json!({ "pass": p, "sig_b64": s, "agent_id": signer, "min_tokens_out": "0" }))
                .deposit(NearToken::from_millinear(500)).gas(Gas::from_tgas(120)).transact().await
        }
    };

    // 1. Valid registered agent → minted.
    let (p, s) = make_pass(1, &agent_key);
    let r = buy(p, s, agent_hex.clone()).await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{:?}", r.failures());
    let after_first = balance(alice.id().clone()).await?;
    assert!(after_first > 0, "valid agent pass should mint");
    println!("valid Shade agent pass → {} PIT atoms", after_first);

    // 2. Unregistered key (never attested) → refunded, nothing minted.
    let rogue = ed25519_dalek::SigningKey::from_bytes(&[43u8; 32]);
    let (p, s) = make_pass(2, &rogue);
    let near_before = alice.view_account().await?.balance.as_yoctonear();
    let r = buy(p, s, hex::encode(rogue.verifying_key().as_bytes())).await?;
    assert!(r.logs().iter().any(|l| l.contains("AgentNotRegistered")), "{:?}", r.logs());
    assert_eq!(balance(alice.id().clone()).await?, after_first);
    // The failed buy credits a durable claim, which the owner withdraws explicitly.
    alice.call(pit.id(), "withdraw_refund").args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(60)).transact().await?.into_result()?;
    // Late gas refunds from earlier txs can land in between, so saturate.
    let spent = near_before.saturating_sub(alice.view_account().await?.balance.as_yoctonear());
    assert!(spent < NEAR / 100, "deposit refunded, only gas spent ({spent})");

    // 3. Owner revokes the agent → its next pass is refunded.
    root.call(registry.id(), "remove_agent").args_json(json!({ "account_id": agent_id })).transact().await?.into_result()?;
    let (p, s) = make_pass(3, &agent_key);
    let r = buy(p, s, agent_hex.clone()).await?;
    assert!(r.logs().iter().any(|l| l.contains("agent_pass_refund_credited")), "{:?}", r.logs());
    assert_eq!(balance(alice.id().clone()).await?, after_first);

    // 4. Sniper without a pass still gets nothing.
    let r = alice.call(pit.id(), "buy").args_json(json!({ "min_tokens_out": "0" }))
        .deposit(NearToken::from_near(1)).gas(Gas::from_tgas(50)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("PassRequired"));
    Ok(())
}

/// The mind on a real chain: memory proposals with measured storage, token
/// locking, and Proof-of-Thought signatures checked by the real Ed25519 host fn.
#[tokio::test]
async fn mind_memory_and_proof_of_thought() -> anyhow::Result<()> {
    use ed25519_dalek::Signer;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let thinker = root.create_subaccount("thinker").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let coin = root.create_subaccount("pit").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?
        .deploy(&std::fs::read(PIT_WASM)?).await?.into_result()?;
    coin.call("new").args(init_args(json!({
        "brain": root.id(), "pools": ["pool.test.near"],
        "virtual_near": (3_000 * NEAR).to_string(),
        "virtual_tokens": (1_073_000_000u128 * 1_000_000_000_000_000_000).to_string(),
        "fee_bps": 100, "buffer_bps": 2_000,
        "tiers": [{ "name": "Larva", "min_principal": "0" }],
        "name": "The Pit", "symbol": "PIT", "icon": null, "launch": null, "creator": null,
        "thinker": thinker.id(),
    }))).transact().await?.into_result()?;

    alice.call(coin.id(), "buy").args_json(json!({ "min_tokens_out": "0" }))
        .deposit(NearToken::from_near(5)).gas(Gas::from_tgas(50)).transact().await?.into_result()?;
    let bal: String = coin.view("ft_balance_of").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    let bal: u128 = bal.parse()?;

    // Propose: overpay 1 NEAR, get the excess back (only real storage is kept).
    let before = alice.view_account().await?.balance.as_yoctonear();
    let r = alice.call(coin.id(), "propose_memory").args_json(json!({ "text": "The pit remembers who fed it." }))
        .deposit(NearToken::from_near(1)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let id: u64 = r.json()?;
    alice.call(coin.id(), "withdraw_refund").args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(60)).transact().await?.into_result()?;
    let spent = before.saturating_sub(alice.view_account().await?.balance.as_yoctonear());
    println!("propose_memory cost {:.5} NEAR (storage + gas)", spent as f64 / NEAR as f64);
    assert!(spent < NEAR / 50, "excess refunded");

    // Back with half the tokens: they move into the contract.
    alice.call(coin.id(), "back_memory").args_json(json!({ "id": id, "amount": (bal / 2).to_string() }))
        .deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    let held: String = coin.view("ft_balance_of").args_json(json!({ "account_id": coin.id() })).await?.json()?;
    assert_eq!(held.parse::<u128>()?, bal / 2);
    let m: Value = coin.view("get_memory").args_json(json!({ "id": id })).await?.json()?;
    assert_eq!(m["memory"]["backed"], (bal / 2).to_string());

    // Unback: tokens come home.
    alice.call(coin.id(), "unback_memory").args_json(json!({ "id": id })).transact().await?.into_result()?;
    let back: String = coin.view("ft_balance_of").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    assert_eq!(back.parse::<u128>()?, bal);

    // Proof of Thought: a NEAR-AI-format gateway signature, verified on-chain.
    let key = ed25519_dalek::SigningKey::from_bytes(&[77u8; 32]);
    let (req, resp) = ("11".repeat(32), "22".repeat(32));
    let signed = format!("{req}:{resp}");
    let thought = |sig: String| json!({ "thought": {
        "text": "I ate today. I feel smarter.", "model": "deepseek-ai/DeepSeek-V3.1", "chat_id": "chatcmpl-1",
        "signature_kind": "gateway", "request_hash": req, "response_hash": resp,
        "signature_hex": sig, "signing_address": hex::encode(key.verifying_key().as_bytes()), "attestation_hash": null,
    }});
    let good = hex::encode(key.sign(signed.as_bytes()).to_bytes());
    let r = thinker.call(coin.id(), "record_thought").args(thought_args(thought(good)))
        .deposit(NearToken::from_millinear(50)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let forged = hex::encode(key.sign(b"something else").to_bytes());
    let r = thinker.call(coin.id(), "record_thought").args(thought_args(thought(forged)))
        .deposit(NearToken::from_millinear(50)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("ThoughtSignatureInvalid"));
    let r = alice.call(coin.id(), "record_thought").args(thought_args(thought(hex::encode(key.sign(signed.as_bytes()).to_bytes()))))
        .deposit(NearToken::from_millinear(50)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("ThinkerOnly"));
    let ts: Vec<Value> = coin.view("get_thoughts").args_json(json!({})).await?.json()?;
    assert_eq!(ts.len(), 1);
    println!("thought recorded on-chain, signed by {}", ts[0]["signing_address"]);
    Ok(())
}

/// Actual failed transfer receipts must retain debt and recover after the
/// destination exists again. Host mocks alone cannot establish this behavior.
#[tokio::test]
async fn failed_native_transfers_keep_claims_until_confirmed_retry() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let pool = root.create_subaccount("recovery-pool").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?
        .deploy(&std::fs::read(POOL_WASM)?).await?.into_result()?;
    pool.call("new").args_json(json!({"unstake_delay_ms":0})).transact().await?.into_result()?;
    let pit = root.create_subaccount("recovery-pit").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?
        .deploy(&std::fs::read(PIT_WASM)?).await?.into_result()?;
    let missing_brain = format!("missing-brain.{}", root.id());
    pit.call("new").args(init_args(json!({
        "brain":missing_brain,"pools":[pool.id()],"virtual_near":(3000*NEAR).to_string(),
        "virtual_tokens":(1_073_000_000u128*1_000_000_000_000_000_000).to_string(),"fee_bps":100,"buffer_bps":2000,
        "tiers":[{"name":"Larva","min_principal":"0"}],"name":"Recovery","symbol":"RCV","icon":null,"launch":null,"creator":null,"thinker":null
    }))).transact().await?.into_result()?;
    let alice = root.create_subaccount("recovery-alice").initial_balance(NearToken::from_near(150)).transact().await?.into_result()?;
    let tokens:String = alice.call(pit.id(),"buy").args_json(json!({"min_tokens_out":"0"})).deposit(NearToken::from_near(100)).gas(Gas::from_tgas(60)).transact().await?.into_result()?.json()?;
    let failed = root.call(pit.id(),"harvest").args_json(json!({})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(!failed.receipt_failures().is_empty(),"nonexistent brain transfer should fail");
    worker.fast_forward(5).await?;
    let claim:Value = pit.view("get_harvest_claim").args_json(json!({"creator":false})).await?.json()?;
    assert_eq!(claim["failed"],true); assert_eq!(claim["in_flight"],false);
    assert_eq!(n(&stats(&pit).await?,"total_harvested"),0);
    root.create_subaccount("missing-brain").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    keeper(&root,&pit,"retry_harvest",json!({"creator":false})).await?;
    worker.fast_forward(5).await?;
    let claim:Value = pit.view("get_harvest_claim").args_json(json!({"creator":false})).await?.json()?;
    assert!(claim.is_null()); assert!(n(&stats(&pit).await?,"total_harvested")>0);
    keeper(&root,&pit,"rebalance",json!({"pool_index":0})).await?;
    let sale:Value = alice.call(pit.id(),"sell").args_json(json!({"amount":tokens,"min_near_out":"0"})).deposit(NearToken::from_millinear(4)).gas(Gas::from_tgas(80)).transact().await?.into_result()?.json()?;
    assert_eq!(sale["status"],"queued");
    let id=sale["ticket_id"].as_u64().expect("ticket ID");
    alice.delete_account(root.id()).await?.into_result()?;
    keeper(&root,&pit,"rebalance",json!({"pool_index":0})).await?;
    keeper(&root,&pit,"rebalance",json!({"pool_index":0})).await?;
    let failed = root.call(pit.id(),"process_queue").args_json(json!({"max":10})).gas(Gas::from_tgas(250)).transact().await?;
    assert!(!failed.receipt_failures().is_empty(),"deleted seller transfer should fail");
    worker.fast_forward(5).await?;
    let ticket:Value = pit.view("get_ticket").args_json(json!({"ticket_id":id})).await?.json()?;
    assert_eq!(ticket["failed"],true);assert_eq!(ticket["in_flight"],false);
    assert!(n(&stats(&pit).await?,"queue_owed")>0);
    let owner = root.create_subaccount("recovery-alice").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    owner.call(pit.id(),"recover_payout").args_json(json!({"ticket_id":id,"receiver_id":root.id()})).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(40)).transact().await?.into_result()?;
    keeper(&root,&pit,"process_queue",json!({"max":10})).await?;
    worker.fast_forward(5).await?;
    let ticket:Value = pit.view("get_ticket").args_json(json!({"ticket_id":id})).await?.json()?;
    assert!(ticket.is_null());assert_eq!(n(&stats(&pit).await?,"queue_owed"),0);
    Ok(())
}
