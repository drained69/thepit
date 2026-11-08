//! Simulated TEE evidence (default mode).
//!
//! Everything this module emits carries `"mode": "SIMULATED"`. It is a
//! signed demo report, not a hardware quote or evidence that code ran in a TEE.
//!
//! Chain of trust in sim mode:
//!   SIM ROOT (ed25519, pub pinned at res/sim-root.pub)
//!      └─ signs quote {measurements, policy_hash, signing_address, nonce}
//!           └─ quote binds the GATE's ed25519 signing key
//!                └─ gate signs passes with that key

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};

/// (gate_signing_key, sim_root_key)
pub fn load_or_create_keys(storage: &str) -> (SigningKey, SigningKey) {
    let dir = std::path::Path::new(storage);
    let _ = std::fs::create_dir_all(dir);
    let enclave = load_key(dir, "sim-enclave.sk");
    let root = load_key(dir, "sim-root.sk");
    (enclave, root)
}

fn load_key(dir: &std::path::Path, name: &str) -> SigningKey {
    let path = dir.join(name);
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            protect_key_file(&path);
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&bytes);
            return SigningKey::from_bytes(&seed);
        }
    }
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    std::fs::write(&path, &seed).expect("persist verifier signing key");
    protect_key_file(&path);
    SigningKey::from_bytes(&seed)
}

#[cfg(unix)]
fn protect_key_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .expect("restrict verifier key permissions");
}

#[cfg(not(unix))]
fn protect_key_file(_path: &std::path::Path) {}

fn sim_digest(tag: &[u8]) -> String {
    hex::encode(Sha256::digest(tag))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Build the simulated attestation report binding nonce + gate signing key.
pub fn sim_evidence(
    sim_root: &SigningKey,
    gate: &SigningKey,
    policy_hash: &str,
    nonce: &str,
) -> serde_json::Value {
    let gate_pub = hex::encode(gate.verifying_key().as_bytes());
    let quote_payload = json!({
        "sim": true,
        "tdx": {
            "mtd": sim_digest(b"mtd-sim"),
            "rtmr0": sim_digest(b"rtmr0-sim"),
            "rtmr3": sim_digest(b"rtmr3-sim"),
            "mrconfig": sim_digest(b"mrconfig-sim"),
            "attributes_debug": false,
        },
        "policy_hash": policy_hash,
        "signing_address": gate_pub,
        "signing_algo": "ed25519",
        "request_nonce": nonce,
        "issued_at_ms": now_ms(),
    });
    let bytes = serde_json::to_vec(&quote_payload).unwrap();
    let sig = sim_root.sign(&bytes);
    json!({
        "mode": "SIMULATED",
        "note": "Simulated demo report for local development. This is not Intel TDX evidence or proof of TEE execution; root public key is res/sim-root.pub.",
        "sim_root_pubkey": hex::encode(sim_root.verifying_key().as_bytes()),
        "quote_b64": B64.encode(&bytes),
        "quote_sig_b64": B64.encode(sig.to_bytes()),
        "signing_address": gate_pub,
        "verify_how": "Verify quote_sig_b64 over the quote_b64 bytes using the sim root public key pinned in the webapp build; this only verifies the demo report signature.",
    })
}
