//! Deterministic challenge policy for the prototype gate.
//!
//! This source hash is included in simulated evidence. The current service
//! does not run in a TEE, and this hash is not a hardware measurement.

use serde_json::json;
use sha2::{Digest, Sha256};

const CATEGORIES: [(&str, &[&str]); 4] = [
    ("food", &["🍩", "🧅", "🍇", "🍗", "🧇", "🥮", "🍫", "🥐"]),
    ("animal", &["🐢", "🦊", "🐙", "🦩", "🐿️", "🪱", "🐝", "🐍"]),
    ("tool", &["🔧", "🪛", "🔩", "🪚", "🧰🧲", "🛠️", "⛏️"]),
    ("travel", &["🚂", "🛴", "🛩️", "⛵", "🚠", "🚟", "🛶"]),
];

#[derive(Debug, Clone)]
pub struct GatePolicy {
    pub verifier_name: String,
    pub pow_target: u64,
    pub pass_cap_tokens: u128,
    pub pass_ttl_ms: u64,
    pub session_ttl_ms: u64,
    pub max_attempts: u32,
    pub hash: String,
}

/// Challenge fully described inside the gate; `answer` never leaves the process.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(crate = "serde")]
pub struct Challenge {
    pub kind: String,
    pub answer: String,
    pub view: serde_json::Value,
    pub max_tokens: u128,
}

impl Challenge {
    pub fn generate(seed: &[u8; 16]) -> Self {
        let rule_idx = (seed[0] as usize) % CATEGORIES.len();
        let odd_idx = (seed[1] as usize) % CATEGORIES.len();
        // Majority category and its two members, plus the odd one's category.
        let (major_word, major_pool) = CATEGORIES[rule_idx];
        let odd_pool: &[&str] = if odd_idx == rule_idx {
            // Odd can't be the majority category — rotate to the next one.
            CATEGORIES[(rule_idx + 1) % CATEGORIES.len()].1
        } else {
            CATEGORIES[odd_idx].1
        };
        let a = major_pool[(seed[2] as usize) % major_pool.len()];
        let b = major_pool[(seed[3] as usize) % major_pool.len()];
        let c = major_pool[(seed[6] as usize) % major_pool.len()];
        let odd_item = odd_pool[(seed[4] as usize) % odd_pool.len()];
        let odd_pos = (seed[5] as usize) % 3;
        let mut options = [
            if a == c { major_pool[(seed[2] as usize + 3) % major_pool.len()] } else { a },
            if b == a || b == c { major_pool[(seed[3] as usize + 3) % major_pool.len()] } else { b },
            c,
        ];
        options[odd_pos] = odd_item;
        Self {
            kind: "odd_one_out".into(),
            answer: odd_pos.to_string(),
            view: json!({
                "prompt": "One of these is not like the others. Tap it.",
                "hint": format!("Two are {} — the odd one is not.", major_word),
                "options": options,
            }),
            max_tokens: 250_000,
        }
    }

    pub fn view(&self) -> serde_json::Value {
        self.view.clone()
    }

    pub fn verify(&self, answer: &str) -> bool {
        answer.trim() == self.answer
    }
}

/// Checked by the gate so browser "solves" can't be a bare reverse-engineer.
pub fn check_pow(nonce: &str, solution: &str, target: u64) -> bool {
    let h = Sha256::digest(format!("{nonce}:{solution}").as_bytes());
    let prefix = u64::from_be_bytes(h[0..8].try_into().unwrap());
    prefix < target
}

pub fn pow_target() -> u64 {
    // ~2^18 expected hashes — instant for a human in a browser, not free for a farm.
    u64::MAX >> 18
}

pub fn policy_hash() -> String {
    // Real enclaves hash their measured binary; here we hash the policy source.
    crate::pass::sha256_hex(include_bytes!("policy.rs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maximum_seed_bytes_do_not_overflow() {
        let challenge = Challenge::generate(&[255; 16]);
        assert!(challenge.verify(&challenge.answer));
    }
}
