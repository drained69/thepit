//! The coin's mind: holder-proposed memories adopted by conviction (tokens × time), and Proof of Thought records.

use crate::*;

#[near]
impl ThePit {

    /// Propose a memory for the brain (≤ 280 bytes). Attach enough NEAR for
    /// its storage; any excess comes back. Returns the memory id.
    #[payable]
    pub fn propose_memory(&mut self, text: String) -> u64 {
        let text = text.trim().to_string();
        require!(
            !text.is_empty() && text.len() <= MAX_MEMORY_BYTES && !text.chars().any(char::is_control),
            err::BAD_MEMORY
        );
        let author = env::predecessor_account_id();
        let id = self.memory_count;
        let before = env::storage_usage();
        self.memories.insert(
            &id,
            &Memory { id, text, author: author.clone(), created_ms: now_ms(), backed: U128(0), backed_since_sum: U128(0), adopted_ms: None },
        );
        self.memory_count += 1;
        self.charge_storage(before, &author);
        event("memory_proposed", &format!(r#"{{"id":{id},"author":"{author}"}}"#));
        id
    }

    /// Lock `amount` tokens behind a memory. Conviction grows the longer they
    /// stay; withdraw any time with `unback_memory`. First backing of a memory
    /// needs a small storage deposit, returned on withdrawal.
    #[payable]
    pub fn back_memory(&mut self, id: u64, amount: U128) {
        require!(amount.0 > 0, err::ZERO);
        let mut m = self.memories.get(&id).unwrap_or_else(|| env::panic_str(err::NO_MEMORY));
        require!(m.adopted_ms.is_none(), err::ADOPTED);
        let who = env::predecessor_account_id();
        let key = format!("{id}|{who}");
        let now = now_ms();

        let before = env::storage_usage();
        let mut b = self.backings.get(&key).unwrap_or(Backing { amount: U128(0), since_ms: now, deposit: U128(0) });
        // Topping up: the new tokens start accruing now.
        let total = b.amount.0 + amount.0;
        let since = (b.amount.0 * u128::from(b.since_ms) + amount.0 * u128::from(now)) / total;
        b.amount = U128(total);
        b.since_ms = since as u64;
        self.ft.internal_transfer(&who, &env::current_account_id(), amount.0, Some("back memory".into()));
        m.backed = U128(m.backed.0 + amount.0);
        m.backed_since_sum = U128(m.backed_since_sum.0 + amount.0 * u128::from(now));
        self.memories.insert(&id, &m);
        self.backings.insert(&key, &b);
        let paid = self.charge_storage(before, &who);
        if paid > 0 {
            b.deposit = U128(b.deposit.0 + paid);
            self.backings.insert(&key, &b);
        }
        event("memory_backed", &format!(r#"{{"id":{id},"account_id":"{who}","amount":"{}"}}"#, amount.0));
    }

    /// Withdraw your tokens (and storage deposit) from a memory — before or
    /// after it's adopted. Adopted memories stay in the canon.
    pub fn unback_memory(&mut self, id: u64) -> U128 {
        let who = env::predecessor_account_id();
        let key = format!("{id}|{who}");
        let b = self.backings.get(&key).unwrap_or_else(|| env::panic_str(err::NO_BACKING));
        let mut m = self.memories.get(&id).unwrap_or_else(|| env::panic_str(err::NO_MEMORY));
        if m.adopted_ms.is_none() {
            m.backed = U128(m.backed.0 - b.amount.0);
            m.backed_since_sum = U128(m.backed_since_sum.0 - b.amount.0 * u128::from(b.since_ms));
            self.memories.insert(&id, &m);
        }
        self.backings.remove(&key);
        self.ft.internal_transfer(&env::current_account_id(), &who, b.amount.0, Some("unback memory".into()));
        if b.deposit.0 > 0 {
            self.credit_refund(&who, b.deposit.0);
        }
        event("memory_unbacked", &format!(r#"{{"id":{id},"account_id":"{who}","amount":"{}"}}"#, b.amount.0));
        b.amount
    }

    /// Anyone can adopt a memory once its conviction reaches the threshold.
    pub fn adopt_memory(&mut self, id: u64) {
        let mut m = self.memories.get(&id).unwrap_or_else(|| env::panic_str(err::NO_MEMORY));
        require!(m.adopted_ms.is_none(), err::ADOPTED);
        require!(self.conviction_of(&m) >= self.adopt_threshold(), err::NOT_YET);
        m.adopted_ms = Some(now_ms());
        self.memories.insert(&id, &m);
        if self.canon.len() == MAX_CANON {
            self.canon.remove(0);
        }
        self.canon.push(id);
        let mut link = self.canon_hash.to_vec();
        link.extend_from_slice(&id.to_le_bytes());
        link.extend_from_slice(&env::sha256(m.text.as_bytes()));
        self.canon_hash = env::sha256_array(&link);
        event("memory_adopted", &format!(r#"{{"id":{id},"canon_hash":"{}"}}"#, hex::encode(self.canon_hash)));
    }

    // ————— the mind: Proof of Thought —————

    /// Record a thought with its NEAR AI Cloud signature. Only the thinker.
    /// The contract checks the signed text has exactly the documented shape
    /// and that the Ed25519 signature is valid. Attach storage (excess back).
    #[payable]
    pub fn record_thought(&mut self, #[serializer(borsh)] thought: ThoughtInput) -> u64 {
        let who = env::predecessor_account_id();
        require!(self.thinker.as_ref() == Some(&who), err::THINKER_ONLY);
        let t = thought;
        let hex64 = |s: &str| s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        require!(
            !t.text.trim().is_empty()
                && t.text.len() <= MAX_THOUGHT_BYTES
                && t.model.len() <= 128
                && t.chat_id.len() <= 128
                && hex64(&t.request_hash)
                && hex64(&t.response_hash)
                && t.attestation_hash.as_deref().is_none_or(hex64),
            err::BAD_THOUGHT
        );
        let signed = match t.signature_kind.as_str() {
            "gateway" => format!("{}:{}", t.request_hash, t.response_hash),
            "provider_tee" => format!("{}:{}:{}", t.model, t.request_hash, t.response_hash),
            _ => env::panic_str(err::BAD_THOUGHT),
        };
        let key = decode_key(&t.signing_address).unwrap_or_else(|| env::panic_str(err::BAD_SIGNATURE));
        let sig: [u8; 64] = hex::decode(&t.signature_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str(err::BAD_SIGNATURE));
        require!(env::ed25519_verify(&sig, signed.as_bytes(), &key), err::BAD_SIGNATURE);

        let id = self.thought_count;
        let before = env::storage_usage();
        let response = hex::decode(&t.response_hash).unwrap_or_else(|_| env::panic_str(err::BAD_THOUGHT));
        require!(self.recorded_responses.insert(&response), err::DUP_THOUGHT);
        let tier = self.tiers[self.tier_index()].name.clone();
        self.thoughts.insert(
            &(id % THOUGHT_SLOTS),
            &Thought {
                id,
                text: t.text,
                model: t.model,
                chat_id: t.chat_id,
                signature_kind: t.signature_kind,
                request_hash: t.request_hash,
                response_hash: t.response_hash.clone(),
                signature_hex: t.signature_hex,
                signing_address: t.signing_address.clone(),
                attestation_hash: t.attestation_hash,
                canon_hash: hex::encode(self.canon_hash),
                tier,
                recorded_ms: now_ms(),
            },
        );
        self.thought_count += 1;
        self.charge_storage(before, &who);
        event(
            "thought",
            &format!(r#"{{"id":{id},"signing_address":"{}","response_hash":"{}"}}"#, t.signing_address, t.response_hash),
        );
        id
    }
}

impl ThePit {
    pub(crate) fn adopt_threshold(&self) -> u128 {
        // Supply × ADOPT_BPS held for ADOPT_WINDOW_MS, in token·ms, with a floor.
        (self.ft.total_supply * ADOPT_BPS / BPS).max(MIN_ADOPT_TOKENS) * ADOPT_WINDOW_MS
    }

    pub(crate) fn conviction_of(&self, m: &Memory) -> u128 {
        (m.backed.0 * u128::from(now_ms())).saturating_sub(m.backed_since_sum.0)
    }

    pub(crate) fn memory_view(&self, m: Memory) -> MemoryView {
        MemoryView { conviction: U128(self.conviction_of(&m)), threshold: U128(self.adopt_threshold()), memory: m }
    }
}
