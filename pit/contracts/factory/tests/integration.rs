//! Sandbox end-to-end for the launchpad: publish the coin code as a global
//! contract, launch a coin through the factory, buy on it with a Shade agent
//! pass, and measure what publishing and launching actually cost.
//!
//! Run: node pit/scripts/build.mjs && cargo test --features integration --test integration -- --nocapture

#![cfg(feature = "integration")]

use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const COIN_WASM: &str = "../pit/target/near/pit.wasm";
const FACTORY_WASM: &str = "target/near/pit_factory.wasm";
const POOL_WASM: &str = "../mock-pool/target/near/mock_pool.wasm";
const REGISTRY_WASM: &str = "../mock-agent-registry/target/near/mock_agent_registry.wasm";
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Base58 for building a NEAR secret key string in tests.
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

fn near(y: u128) -> f64 {
    y as f64 / NEAR as f64
}

#[tokio::test]
async fn launch_a_coin_and_trade_it() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;

    let pool = root.create_subaccount("pool").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?
        .deploy(&std::fs::read(POOL_WASM)?).await?.into_result()?;
    pool.call("new").args_json(json!({ "unstake_delay_ms": 0 })).transact().await?.into_result()?;
    let registry = root.create_subaccount("registry").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?
        .deploy(&std::fs::read(REGISTRY_WASM)?).await?.into_result()?;
    registry.call("new").args_json(json!({ "owner_id": root.id(), "attestation_expiration_time_ms": "604800000" })).transact().await?.into_result()?;
    let brain = root.create_subaccount("brain").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    let creator = root.create_subaccount("creator").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;

    let coin_code = std::fs::read(COIN_WASM)?;
    let factory = root.create_subaccount("factory").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?
        .deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    factory.call("new").args_json(json!({
        "coin_code_hash_hex": hex::encode(Sha256::digest(&coin_code)),
        "brain": brain.id(),
        "thinker": brain.id(),
        "pools": [pool.id()],
        "agent_registry": registry.id(),
        "verifiers": [],
        "defaults": {
            "virtual_near": (3_000 * NEAR).to_string(),
            "virtual_tokens": (1_073_000_000u128 * 1_000_000_000_000_000_000).to_string(),
            "fee_bps": 100, "buffer_bps": 2_000,
            "tiers": [{ "name": "Larva", "min_principal": "0" }, { "name": "Juvenile", "min_principal": (1_000 * NEAR).to_string() }]
        },
        "coin_deposit": (NEAR / 10).to_string(),
    })).transact().await?.into_result()?;

    // Launching before the code is published fails cleanly.
    let r = creator.call(factory.id(), "create_coin")
        .args_json(json!({ "symbol": "early", "name": "Too Early", "icon": null, "launch": null, "creator_share_bps": 0 }))
        .deposit(NearToken::from_near(1)).gas(Gas::from_tgas(150)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("CoinCodeNotPublished"));

    // Wrong code is refused.
    let r = root.call(factory.id(), "publish_coin_code").args_borsh(vec![0u8; 100])
        .deposit(NearToken::from_near(1)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("CodeHashMismatch"));

    // Publish the real coin code once, as a global contract.
    let burn = coin_code.len() as u128 * 10_000_000_000_000_000_000 * 10;
    let before = root.view_account().await?.balance.as_yoctonear() + factory.view_account().await?.balance.as_yoctonear();
    let r = root.call(factory.id(), "publish_coin_code").args_borsh(coin_code.clone())
        .deposit(NearToken::from_yoctonear(burn)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{:?}", r.failures());
    let after = root.view_account().await?.balance.as_yoctonear() + factory.view_account().await?.balance.as_yoctonear();
    println!("publish: code {} bytes, attached {:.2} NEAR, actually spent {:.3} NEAR (incl. gas)", coin_code.len(), near(burn), near(before - after));
    let cfg: Value = factory.view("get_config").await?.json()?;
    assert_eq!(cfg["code_published"], true);

    // Launch DOGE with a humans-first launch and a 30% creator cut.
    let cost: String = factory.view("create_cost").args_json(json!({ "icon_bytes": 4 })).await?.json()?;
    let cost: u128 = cost.parse()?;
    let creator_before = creator.view_account().await?.balance.as_yoctonear();
    let r = creator.call(factory.id(), "create_coin")
        .args_json(json!({
            "symbol": "doge", "name": "Doge Pit", "icon": "🐶",
            "launch": { "starts_in_ms": "0", "epochs": [{ "duration_ms": "3600000", "per_buyer_max_tokens": "2000000" }] },
            "creator_share_bps": 3000
        }))
        .deposit(NearToken::from_yoctonear(cost + NEAR)) // overpay 1 NEAR: must come back
        .gas(Gas::from_tgas(150)).transact().await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{:?}", r.failures());
    // The sandbox's final execution result can precede gas-refund receipts.
    worker.fast_forward(5).await?;
    let spent = creator_before - creator.view_account().await?.balance.as_yoctonear();
    println!("launch: create_cost {:.3} NEAR, creator actually spent {:.4} NEAR (incl. gas)", near(cost), near(spent));
    let burnt: u128 = r.outcomes().iter().map(|outcome| outcome.tokens_burnt.as_yoctonear()).sum();
    println!("launch diagnostics: total burnt {} NEAR, gas {}", near(burnt), r.total_gas_burnt.as_gas());
    assert!(factory.view("get_refund").args_json(json!({"launch_id":"0"})).await?.json::<Value>()?.is_null(), "initial excess refund must be confirmed");
    assert!(spent < cost + NEAR / 100, "overpayment refunded");

    let coin_id: near_workspaces::AccountId = format!("doge.{}", factory.id()).parse()?;
    let coins: Vec<Value> = factory.view("get_coins").args_json(json!({})).await?.json()?;
    assert_eq!(coins.len(), 1);
    assert_eq!(coins[0]["icon"], "🐶");
    assert_eq!(coins[0]["has_image"], false);
    assert_eq!(coins[0]["account_id"], coin_id.as_str());
    let meta: Value = worker.view(&coin_id, "ft_metadata").await?.json()?;
    assert_eq!(meta["symbol"], "DOGE");
    let info: Value = worker.view(&coin_id, "launch_info").await?.json()?;
    assert_eq!(info["phase"], "gated");
    assert_eq!(info["launch"]["sale_id"], "PIT-DOGE");
    let mind: Value = worker.view(&coin_id, "get_mind").await?.json()?;
    assert_eq!(mind[0], brain.id().as_str(), "factory hands every coin its thinker");
    let coin_acct = worker.view_account(&coin_id).await?;
    println!("coin account: {} bytes of storage, {:.3} NEAR balance (code is shared, not stored)", coin_acct.storage_usage, near(coin_acct.balance.as_yoctonear()));
    assert!(coin_acct.storage_usage < 10_000, "a coin must not store its own copy of the code");

    // Same symbol again: refunded, nothing recorded.
    let creator_before = creator.view_account().await?.balance.as_yoctonear();
    let r = creator.call(factory.id(), "create_coin")
        .args_json(json!({ "symbol": "doge", "name": "Copycat", "icon": null, "launch": null, "creator_share_bps": 0 }))
        .deposit(NearToken::from_yoctonear(cost)).gas(Gas::from_tgas(150)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("SymbolTaken"), "{:?}", r.failures());
    assert!(creator_before.saturating_sub(creator.view_account().await?.balance.as_yoctonear()) < NEAR / 100);

    // A pre-existing child account forces an asynchronous create failure.
    // The refund is confirmed through real receipts and the storage fee stays funded.
    factory.as_account().create_subaccount("blocked").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    let before_failed = creator.view_account().await?.balance.as_yoctonear();
    let failed = creator.call(factory.id(), "create_coin")
        .args_json(json!({ "symbol":"blocked", "name":"Blocked", "icon":null, "launch":null, "creator_share_bps":0 }))
        .deposit(NearToken::from_yoctonear(cost)).gas(Gas::from_tgas(150)).transact().await?;
    assert_eq!(failed.json::<bool>()?, false);
    worker.fast_forward(5).await?;
    let lost = before_failed.saturating_sub(creator.view_account().await?.balance.as_yoctonear());
    assert!(lost >= NEAR/500 && lost < NEAR/100, "failure retains only claim storage plus gas; lost {lost}");
    let claim: Value = factory.view("get_refund").args_json(json!({"launch_id":"1"})).await?.json()?;
    assert!(claim.is_null(), "confirmed refund claim must be removed");

    // An uploaded image icon: the creator pays for its bytes, the coin keeps it,
    // and the registry record stays small.
    use base64::Engine;
    let img = format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(vec![7u8; 9_000]));
    let img_cost: String = factory.view("create_cost").args_json(json!({ "icon_bytes": img.len() })).await?.json()?;
    let img_cost: u128 = img_cost.parse()?;
    assert_eq!(img_cost - cost, (img.len() as u128 - 4) * 10u128.pow(19), "icon bytes priced at storage rate");
    let r = creator.call(factory.id(), "create_coin")
        .args_json(json!({ "symbol": "pepe", "name": "Pepe Pit", "icon": img, "launch": null, "creator_share_bps": 0 }))
        .deposit(NearToken::from_yoctonear(cost)).gas(Gas::from_tgas(150)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("AttachCreateDeposit"), "image icons must pay for their bytes");
    let r = creator.call(factory.id(), "create_coin")
        .args_json(json!({ "symbol": "pepe", "name": "Pepe Pit", "icon": img, "launch": null, "creator_share_bps": 0 }))
        .deposit(NearToken::from_yoctonear(img_cost)).gas(Gas::from_tgas(150)).transact().await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{:?}", r.failures());
    let rec: Value = factory.view("get_coin").args_json(json!({ "symbol": "pepe" })).await?.json()?;
    assert_eq!(rec["has_image"], true);
    assert_eq!(rec["icon"], Value::Null, "the record doesn't duplicate the image");
    let pepe: near_workspaces::AccountId = format!("pepe.{}", factory.id()).parse()?;
    let meta: Value = worker.view(&pepe, "ft_metadata").await?.json()?;
    assert_eq!(meta["icon"], img.as_str());
    let pepe_acct = worker.view_account(&pepe).await?;
    println!("image coin: {} byte icon, {} bytes of storage, {:.3} NEAR balance", img.len(), pepe_acct.storage_usage, near(pepe_acct.balance.as_yoctonear()));
    for bad in ["data:image/svg+xml;base64,PHN2Zz4=", "https://evil.example/x.png", "a\u{202E}b"] {
        let r = creator.call(factory.id(), "create_coin")
            .args_json(json!({ "symbol": "bad", "name": "Bad", "icon": bad, "launch": null, "creator_share_bps": 0 }))
            .deposit(NearToken::from_yoctonear(img_cost)).gas(Gas::from_tgas(150)).transact().await?;
        assert!(format!("{:?}", r.failures()).contains("BadIcon"), "{bad}: {:?}", r.failures());
    }

    // Trade the new coin with a Shade agent pass — the shared code runs fully.
    use ed25519_dalek::Signer;
    let agent_key = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
    let agent_hex = hex::encode(agent_key.verifying_key().as_bytes());
    let mut kp = agent_key.to_bytes().to_vec();
    kp.extend_from_slice(agent_key.verifying_key().as_bytes());
    let secret: near_workspaces::types::SecretKey = format!("ed25519:{}", bs58(&kp)).parse()?;
    let agent_id: near_workspaces::AccountId = agent_hex.parse()?;
    root.transfer_near(&agent_id, NearToken::from_near(1)).await?.into_result()?;
    let agent = near_workspaces::Account::from_secret_key(agent_id.clone(), secret, &worker);
    root.call(registry.id(), "whitelist_agent_for_local").args_json(json!({ "account_id": agent_id })).transact().await?.into_result()?;
    agent.call(registry.id(), "register_agent").args_json(json!({ "attestation": {} }))
        .deposit(NearToken::from_millinear(5)).transact().await?.into_result()?;

    let pass = json!({
        "v": 1, "sale": "PIT-DOGE", "kind": "human", "buyer": alice.id(), "epoch": 0,
        "max_amount": "1000000", "nonce": "ab".repeat(32), "expires_at_ms": now_ms + 600_000,
    }).to_string();
    let sig = base64::engine::general_purpose::STANDARD.encode(agent_key.sign(pass.as_bytes()).to_bytes());
    let r = alice.call(&coin_id, "buy_with_agent_pass")
        .args_json(json!({ "pass": pass, "sig_b64": sig, "agent_id": agent_hex, "min_tokens_out": "0" }))
        .deposit(NearToken::from_near(2)).gas(Gas::from_tgas(150)).transact().await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{:?}", r.failures());
    let bal: String = worker.view(&coin_id, "ft_balance_of").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    assert!(bal.parse::<u128>()? > 0);
    println!("alice bought {} DOGE atoms on the launched coin", bal);

    // Harvest the fee: 30% to the creator, 70% to the brain.
    let h = root.call(&coin_id, "harvest").gas(Gas::from_tgas(50)).transact().await?;
    assert!(h.is_success(), "{:?}", h.failures());
    let stats: Value = worker.view(&coin_id, "brain_stats").await?.json()?;
    let brain_got: u128 = stats["total_harvested"].as_str().unwrap().parse()?;
    let creator_got: u128 = stats["creator_earned"].as_str().unwrap().parse()?;
    assert!(creator_got > 0);
    assert_eq!(creator_got, (brain_got + creator_got) * 3_000 / 10_000, "creator gets exactly 30%");
    println!("harvest: brain {:.5} NEAR, creator {:.5} NEAR", near(brain_got), near(creator_got));
    Ok(())
}
