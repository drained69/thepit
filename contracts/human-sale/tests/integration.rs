//! Sandbox integration tests (near-workspaces) — the FULL on-chain flow.
//!
//! Run: `cargo test --features integration --test integration`
//! Requires the near-sandbox binary (near-workspaces downloads it).
//! Unit tests are the primary proving set; these wire the full lifecycle:
//! deploy → register verifier → human pass → purchase → replay/spoof on-chain.

#![cfg(feature = "integration")]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::Signer;
use near_workspaces::types::NearToken;
use serde_json::json;
use sha2::{Digest, Sha256};

const WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/near/human_sale.wasm");

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn epochs_from(start: u64) -> serde_json::Value {
    let w = 120_000u64; // 2-minute demo epochs
    // near-sdk 5.x JSON schema: u128 fields deserialize from JSON NUMBERS
    // (verified by unit test `epoch_json_deser_numbers_required`).
    let y = 10u128.pow(24);
    let price_u64 = |t: u128| u64::try_from(y / t).unwrap();
    let e = |i: u64, t_per_near: u128, cap: u128, per: u128| {
        json!({
            "starts_at_ms": start + i * w,
            "ends_at_ms": start + (i + 1) * w,
            "price_yocto_per_token": price_u64(t_per_near),
            "per_buyer_max_tokens": per,
            "epoch_cap_tokens": cap,
        })
    };
    json!({
        "epochs": [
            e(0, 50_000_000, 30_000_000, 2_000_000),
            e(1, 30_000_000, 80_000_000, 10_000_000),
            e(2, 16_666_666, 140_000_000, 30_000_000),
        ],
        "open_cfg": {
            "ends_at_ms": start + 4 * w,
            "price_yocto_per_token": price_u64(6_666_666),
            "per_buyer_max_tokens": 10_000_000,
            "open_cap_tokens": 50_000_000,
        }
    })
}

fn pass_json(buyer: &str, epoch: u32, tokens: u128, expires: u64, nonce_hex: &str) -> String {
    json!({
        "v": 1, "sale": "HUMAN-001", "kind": "human",
        "buyer": buyer, "epoch": epoch,
        "max_amount": tokens.to_string(),
        "nonce": nonce_hex, "expires_at_ms": expires,
    })
    .to_string()
}

fn sign_b64(pass_json: &str, sk: &ed25519_dalek::SigningKey) -> String {
    B64.encode(sk.sign(pass_json.as_bytes()).to_bytes())
}

#[tokio::test]
async fn sandbox_full_human_flow() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(WASM)?;
    let contract = worker.dev_deploy(&wasm).await?;

    let t0 = now_ms();
    let init = contract
        .call("new")
        .args_json(json!({
            "owner": contract.id(),
            "sale_id": "HUMAN-001",
            "epochs": epochs_from(t0 + 5_000)["epochs"],
            "open_cfg": epochs_from(t0 + 5_000)["open_cfg"],
            "total_supply": "1000000000000000000000000000000000",
            "treasury_percent": 70,
            "token_name": "HUMAN",
            "token_symbol": "HUMAN",
            "token_decimals": 24,
            "token_icon": null,
            "metadata_reference": null,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(init.is_success(), "init failed: {:?}", format!("{:?}", init.receipt_failures()));

    // Pin a DEV gate key — in production this is the TEE-bound key the
    // fail-closed register-verifier.mjs pins after verifying evidence.
    let gate = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
    let pk_hex = hex::encode(gate.verifying_key().as_bytes());
    let reg = contract
        .call("register_verifier")
        .args_json(json!({
            "pubkey_hex": pk_hex,
            "name": "human-gate-integration",
            "evidence_hash_hex": hex::encode(Sha256::digest(b"sandbox-evidence")),
        }))
        .transact()
        .await?;
    assert!(reg.is_success(), "register_verifier failed: {:?}", format!("{:?}", reg.receipt_failures()));

    // Human arrives: funded account + NEP-141 registration.
    let human = worker.dev_create_account().await?;
    let _ = human
        .call(contract.id(), "storage_deposit")
        .args_json(json!({"account_id": human.id(), "registration_only": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;

    // Craft a pass exactly like tee-gate does, then jump into epoch 0.
    // Epoch 0 spans [t0+5s, t0+125s]; fast_forward advances BLOCKS (~0.6s each).
    let pass = pass_json(human.id().as_str(), 0, 100, t0 + 125_000, &"ab".repeat(32));
    let sig_b64 = sign_b64(&pass, &gate);
    worker.fast_forward(20).await?;

    // deposit for 100 tokens @ 2e16 yocto/token = 2e18
    let buy = human
        .call(contract.id(), "purchase")
        .args_json(json!({ "pass": pass.clone(), "sig_b64": sig_b64 }))
        .deposit(NearToken::from_yoctonear(2_000_000_000_000_000_000))
        .transact()
        .await?;
    assert!(buy.is_success(), "purchase failed: {:?}", format!("{:?}", buy.receipt_failures()));

    let bal = contract
        .call("ft_balance_of")
        .args_json(json!({ "account_id": human.id() }))
        .view()
        .await?
        .json::<String>()?;
    assert_eq!(bal, (100u128 * 10u128.pow(24)).to_string(), "human minted 100 whole tokens");

    // ——— on-chain rejections in sandbox: replay + theft ———
    let replay = human
        .call(contract.id(), "purchase")
        .args_json(json!({ "pass": pass, "sig_b64": sig_b64 }))
        .deposit(NearToken::from_yoctonear(2_000_000_000_000_000_000))
        .transact()
        .await?;
    let replay_panic = format!("{:?}", replay.receipt_failures());
    assert!(replay.is_failure(), "replay must fail");
    assert!(replay_panic.contains("PassReplay"), "expected PassReplay, got: {replay_panic}");

    let thief = worker.dev_create_account().await?;
    let _ = thief
        .call(contract.id(), "storage_deposit")
        .args_json(json!({"account_id": thief.id(), "registration_only": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    let stolen = thief
        .call(contract.id(), "purchase")
        .args_json(json!({ "pass": pass_json(human.id().as_str(), 0, 100, t0 + 125_000, &"cc".repeat(32)), "sig_b64": sign_b64(&pass_json(human.id().as_str(), 0, 100, t0 + 125_000, &"cc".repeat(32)), &gate) }))
        .deposit(NearToken::from_yoctonear(2_000_000_000_000_000_000))
        .transact()
        .await?;
    assert!(stolen.is_failure(), "stolen pass must fail");
    let stolen_panic = format!("{:?}", stolen.receipt_failures());
    assert!(stolen_panic.contains("PassNotForYou"), "expected PassNotForYou, got: {stolen_panic}");

    println!("✅ sandbox full flow: mint → replay blocked (PassUsed) → theft blocked (PassNotForYou)");
    Ok(())
}
