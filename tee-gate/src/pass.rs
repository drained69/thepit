//! Canonical pass types — byte-compatible with the on-chain contract's
//! `PassToken` (contracts/human-sale/src/lib.rs). Field order matters: the
//! verifier signs these exact bytes and the contract verifies those exact bytes.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(crate = "serde")]
pub struct PassToken {
    pub v: u32,
    pub sale: String,
    /// "human" in v1.
    pub kind: String,
    pub buyer: String,
    pub epoch: u32,
    /// Whole $HUMAN tokens, string.
    pub max_amount: String,
    /// 64 hex chars, one-shot on-chain.
    pub nonce: String,
    pub expires_at_ms: u64,
}

impl PassToken {
    pub fn sign(&self, key: &ed25519_dalek::SigningKey) -> String {
        let bytes = serde_json::to_vec(self).expect("pass serialization is infallible");
        use ed25519_dalek::Signer;
        let sig = key.sign(&bytes);
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("pass serialization is infallible")
    }
}

/// SHA-256 helper used for policy hash + used-pass hashing on chain.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}
