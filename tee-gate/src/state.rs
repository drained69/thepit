//! Gate state: sessions, pass issuance.

use std::collections::HashMap;
use std::sync::Mutex;

use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use rand::RngCore;

use crate::pass::sha256_hex;
use crate::policy::{check_pow, Challenge, GatePolicy};

const MAX_SESSIONS: usize = 10_000;
const MAX_SESSIONS_PER_BUYER: usize = 3;

pub struct Session {
    pub nonce: String,
    pub buyer: String,
    pub epoch: u32,
    pub challenge: Challenge,
    pub attempts: u32,
    pub created_ms: u64,
}

pub struct GateState {
    pub mode: String, // "sim" | "nearai"
    pub sale_id: String,
    /// Local demo key used to sign allocation passes.
    pub signing: SigningKey,
    pub sim_root: SigningKey,
    pub policy: GatePolicy,
    sessions: Mutex<HashMap<String, Session>>,
}

/// Fresh random material for session IDs, nonces, and challenge generation.
fn rand_seed() -> [u8; 16] {
    let mut out = [0u8; 16];
    OsRng.fill_bytes(&mut out);
    out
}

impl GateState {
    pub fn new(
        mode: &str,
        sale_id: &str,
        signing: SigningKey,
        sim_root: SigningKey,
        policy: GatePolicy,
    ) -> Self {
        GateState {
            mode: mode.into(),
            sale_id: sale_id.into(),
            signing,
            sim_root,
            policy,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    pub fn signing_address(&self) -> String {
        hex::encode(self.signing.verifying_key().as_bytes())
    }

    pub fn sim_root_address(&self) -> String {
        hex::encode(self.sim_root.verifying_key().as_bytes())
    }

    pub fn issue_challenge(&self, buyer: &str, epoch: u32) -> serde_json::Value {
        let now = Self::now_ms();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, s| now <= s.created_ms.saturating_add(self.policy.session_ttl_ms));
        if sessions.len() >= MAX_SESSIONS
            || sessions.values().filter(|s| s.buyer == buyer).count() >= MAX_SESSIONS_PER_BUYER
        {
            return serde_json::json!({ "error": "gate_busy", "retry_after_seconds": 10 });
        }
        let session_id = hex::encode(rand_seed());
        let nonce = sha256_hex(&rand_seed());
        let challenge = Challenge::generate(&rand_seed());

        sessions.insert(
            session_id.clone(),
            Session {
                nonce: nonce.clone(),
                buyer: buyer.to_string(),
                epoch,
                challenge,
                attempts: 0,
                created_ms: now,
            },
        );

        let s = &sessions[&session_id];
        serde_json::json!({
            "session_id": session_id,
            "nonce": nonce,
            "pow_target": self.policy.pow_target,
            "pow_rule": "find a string X such that sha256(nonce + ':' + X) < target; send X as pow_solution",
            "challenge": s.challenge.view(),
            "pass_ttl_ms": self.policy.pass_ttl_ms,
        })
    }

    /// Check PoW + answer; on success return the signed pass. Evidence is
    /// attached by the route handler (it needs async for the NEAR AI mode).
    pub fn solve(
        &self,
        session_id: &str,
        pow_solution: &str,
        answer: &str,
    ) -> Result<serde_json::Value, String> {
        let mut sessions = self.sessions.lock().unwrap();
        let now = Self::now_ms();
        let session = match sessions.get_mut(session_id) {
            Some(s) => s,
            None => return Err("session_not_found".into()),
        };
        if now > session.created_ms + self.policy.session_ttl_ms {
            sessions.remove(session_id);
            return Err("session_expired".into());
        }
        session.attempts += 1;
        if session.attempts > self.policy.max_attempts {
            sessions.remove(session_id);
            return Err("too_many_attempts".into());
        }
        if !check_pow(&session.nonce, pow_solution, self.policy.pow_target) {
            return Err("pow_failed".into());
        }
        if !session.challenge.verify(answer) {
            sessions.remove(session_id);
            return Err("challenge_failed".into());
        }

        let pass = crate::pass::PassToken {
            v: 1,
            sale: self.sale_id.clone(),
            kind: "human".into(),
            buyer: session.buyer.clone(),
            epoch: session.epoch,
            max_amount: session
                .challenge
                .max_tokens
                .min(self.policy.pass_cap_tokens)
                .to_string(),
            nonce: session.nonce.clone(),
            expires_at_ms: now + self.policy.pass_ttl_ms,
        };
        let pass_json = pass.to_json();
        let sig_b64 = crate::pass::PassToken::sign(&pass, &self.signing);
        let nonce = pass.nonce.clone();
        let signing_address = self.signing_address();
        sessions.remove(session_id); // session is one-shot

        Ok(serde_json::json!({
            "pass": pass_json,
            "pass_nonce": nonce,
            "sig_b64": sig_b64,
            "signing_algo": "ed25519",
            "verifier": {
                "name": self.policy.verifier_name,
                "signing_address": signing_address,
                "signing_algo": "ed25519",
                "mode": self.mode,
            },
            "policy_hash": self.policy.hash,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> GateState {
        GateState::new("sim", "PIT-001", SigningKey::from_bytes(&[1; 32]), SigningKey::from_bytes(&[2; 32]), GatePolicy {
            verifier_name: "test".into(), pow_target: u64::MAX, pass_cap_tokens: 250_000,
            pass_ttl_ms: 60_000, session_ttl_ms: 60_000, max_attempts: 5, hash: "test".into(),
        })
    }

    #[test]
    fn solved_proof_allows_only_one_answer() {
        let gate = gate();
        let issued = gate.issue_challenge("alice.testnet", 0);
        let id = issued["session_id"].as_str().unwrap();
        let nonce = issued["nonce"].as_str().unwrap();
        let answer = gate.sessions.lock().unwrap()[id].challenge.answer.clone();
        let wrong = if answer == "0" { "1" } else { "0" };
        let solution = (0..).map(|i| i.to_string()).find(|s| check_pow(nonce, s, u64::MAX)).unwrap();
        assert_eq!(gate.solve(id, &solution, wrong).unwrap_err(), "challenge_failed");
        assert_eq!(gate.solve(id, &solution, &answer).unwrap_err(), "session_not_found");
    }
}
