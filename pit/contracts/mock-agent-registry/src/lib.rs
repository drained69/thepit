/*
 * mock-agent-registry — TEST ONLY. Never use it for a real launch.
 *
 * Mirrors the NearDeFi Shade Agent contract (shade-contract-template) in its
 * local mode, `requires_tee = false`: the owner whitelists an agent account,
 * the agent calls `register_agent` itself, and `get_agent` reports validity
 * with the same JSON shape (`"Valid"` or `{"Invalid": [reasons]}`). It does
 * NOT verify TEE attestations. Production uses the real agent contract with
 * `requires_tee = true`, approved measurements and PPIDs.
 */

use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockAgentRegistry {
    owner_id: AccountId,
    attestation_expiration_time_ms: u64,
    whitelist: LookupSet<AccountId>,
    /// agent → valid_until_ms
    agents: LookupMap<AccountId, u64>,
}

#[near]
impl MockAgentRegistry {
    #[init]
    pub fn new(owner_id: AccountId, attestation_expiration_time_ms: U64) -> Self {
        Self {
            owner_id,
            attestation_expiration_time_ms: attestation_expiration_time_ms.0,
            whitelist: LookupSet::new(b"w".to_vec()),
            agents: LookupMap::new(b"a".to_vec()),
        }
    }

    pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Caller is not the owner");
        self.whitelist.insert(&account_id);
    }

    pub fn remove_agent(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Caller is not the owner");
        self.agents.remove(&account_id);
        self.whitelist.remove(&account_id);
    }

    /// Called by the agent. The attestation is ignored, as in local mode.
    #[payable]
    pub fn register_agent(&mut self, attestation: Value) -> bool {
        let _ = attestation;
        let agent = env::predecessor_account_id();
        require!(self.whitelist.contains(&agent), "Agent needs to be whitelisted for local mode");
        self.agents.insert(&agent, &(env::block_timestamp_ms() + self.attestation_expiration_time_ms));
        true
    }

    pub fn get_contract_info(&self) -> Value {
        json!({
            "requires_tee": false,
            "attestation_expiration_time_ms": U64(self.attestation_expiration_time_ms),
            "owner_id": self.owner_id,
            "mpc_contract_id": "mock.near",
        })
    }

    pub fn get_agent(&self, account_id: AccountId) -> Option<Value> {
        let valid_until_ms = self.agents.get(&account_id)?;
        let mut reasons = vec![];
        if valid_until_ms < env::block_timestamp_ms() {
            reasons.push("ExpiredAttestation");
        }
        if !self.whitelist.contains(&account_id) {
            reasons.push("NotWhitelistedForLocal");
        }
        let validity = if reasons.is_empty() { json!("Valid") } else { json!({ "Invalid": reasons }) };
        Some(json!({
            "account_id": account_id,
            "measurements": { "mock": true },
            "ppid": "00000000000000000000000000000000",
            "valid_until_ms": U64(valid_until_ms),
            "validity": validity,
        }))
    }
}
