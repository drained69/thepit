//! Read-only methods for wallets, the web app and the brain.

use crate::*;

#[near]
impl ThePit {

    /// Tokens out for `near_in` attached (after fee; excludes storage cost).
    pub fn quote_buy(&self, near_in: U128) -> U128 {
        U128(self.quote_buy_net(near_in.0 - self.fee_of(near_in.0)))
    }

    /// NEAR out (after fee) for selling `amount` tokens.
    pub fn quote_sell(&self, amount: U128) -> U128 {
        let gross = self.quote_sell_gross(amount.0);
        U128(gross - self.fee_of(gross))
    }

    /// Spot price: yoctoNEAR per whole token.
    pub fn spot_price(&self) -> U128 {
        U128(mul_div(self.near_reserve(), ONE_TOKEN, self.token_reserve()))
    }

    pub fn get_pools(&self) -> Vec<PoolState> {
        self.pools.clone()
    }

    pub fn get_tiers(&self) -> Vec<Tier> {
        self.tiers.clone()
    }

    /// Paginate active-set indices; ordering may change when claims complete.
    pub fn get_queue(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Ticket> {
        let start = from.unwrap_or(0).min(self.queue_ids.len());
        let end = start.saturating_add(limit.unwrap_or(20).min(100)).min(self.queue_ids.len());
        (start..end).filter_map(|index| self.queue_ids.as_vector().get(index).and_then(|id| self.queue.get(&id))).collect()
    }

    pub fn get_ticket(&self, ticket_id: u64) -> Option<Ticket> {
        self.queue.get(&ticket_id)
    }

    /// Launch schedule, verifier keys and the live phase.
    pub fn launch_info(&self) -> LaunchInfo {
        let (phase, epoch) = self.phase_label();
        LaunchInfo { phase: phase.into(), epoch, now_ms: now_ms(), launch: self.launch.clone() }
    }

    /// Whole-token atoms an account bought with passes in `epoch`.
    pub fn gated_bought(&self, account_id: AccountId, epoch: u32) -> U128 {
        U128(self.gated_bought.get(&format!("{account_id}|{epoch}")).unwrap_or(0))
    }

    pub fn pass_used(&self, pass: String) -> bool {
        self.used_passes.contains(&env::sha256(pass.as_bytes()))
    }

    /// The bonding curve's parameters, so a UI can draw it:
    /// NEAR reserve = virtual_near + principal, token reserve = virtual_tokens − supply.
    pub fn curve_info(&self) -> (U128, U128, U128, U128, u16) {
        (U128(self.virtual_near), U128(self.virtual_tokens), U128(self.principal), U128(self.ft.total_supply), self.fee_bps)
    }

    /// Everything the brain meter needs in one call.
    pub fn brain_stats(&self) -> BrainStats {
        let tier = self.tier_index();
        BrainStats {
            brain: self.brain.clone(),
            principal: U128(self.principal),
            liquid: U128(self.liquid),
            staked: U128(self.pools.iter().map(|p| p.staked.0).sum()),
            unstaking: U128(self.pools.iter().map(|p| p.unstaked.0).sum()),
            surplus: U128(self.surplus()),
            target_liquid: U128(self.target_liquid()),
            queue_owed: U128(self.queue_owed),
            queue_len: self.queue_ids.len(),
            total_harvested: U128(self.total_harvested),
            creator: self.creator.clone(),
            creator_earned: U128(self.creator_earned),
            total_fees: U128(self.total_fees),
            total_supply: U128(self.ft.total_supply),
            spot_price: self.spot_price(),
            fee_bps: self.fee_bps,
            buffer_bps: self.buffer_bps,
            tier_index: tier as u32,
            tier: self.tiers[tier].clone(),
            next_tier: self.tiers.get(tier + 1).cloned(),
            pool_op_in_flight: self.lock_ms.is_some(),
            phase: self.phase_label().0.into(),
        }
    }

    // ————— mind views —————

    pub fn get_memory(&self, id: u64) -> Option<MemoryView> {
        self.memories.get(&id).map(|m| self.memory_view(m))
    }

    /// Newest first. `pending_only` hides adopted ones.
    pub fn get_memories(&self, from_index: Option<u64>, limit: Option<u64>, pending_only: Option<bool>) -> Vec<MemoryView> {
        let n = self.memory_count;
        let skip = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(50) as usize;
        (0..n.saturating_sub(skip))
            .rev()
            .filter_map(|i| self.memories.get(&i))
            .filter(|m| !pending_only.unwrap_or(false) || m.adopted_ms.is_none())
            .take(limit)
            .map(|m| self.memory_view(m))
            .collect()
    }

    /// The canon the brain reads, oldest first, and its hash.
    pub fn get_canon(&self) -> (Vec<Memory>, String) {
        (self.canon.iter().filter_map(|id| self.memories.get(id)).collect(), hex::encode(self.canon_hash))
    }

    pub fn get_backing(&self, id: u64, account_id: AccountId) -> Option<Backing> {
        self.backings.get(&format!("{id}|{account_id}"))
    }

    /// Newest first (only the last THOUGHT_SLOTS stay in state).
    pub fn get_thoughts(&self, limit: Option<u64>) -> Vec<Thought> {
        let n = self.thought_count;
        let k = limit.unwrap_or(THOUGHT_SLOTS).min(THOUGHT_SLOTS).min(n);
        (0..k).filter_map(|i| self.thoughts.get(&((n - 1 - i) % THOUGHT_SLOTS))).collect()
    }

    pub fn get_mind(&self) -> (Option<AccountId>, u64, u64, String) {
        (self.thinker.clone(), self.thought_count, self.memory_count, hex::encode(self.canon_hash))
    }
}

impl ThePit {
    pub(crate) fn tier_index(&self) -> usize {
        self.tiers
            .iter()
            .rposition(|t| self.principal >= t.min_principal.0)
            .unwrap_or(0)
    }
}
