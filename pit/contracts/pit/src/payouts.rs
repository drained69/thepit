//! Seller payouts, harvests to the brain and creator, and per-account refund credits.
//! Every transfer stays locked until its callback confirms it; nothing is resent on a timeout.

use crate::*;

#[near]
impl ThePit {

    /// Dispatch a rotating batch of active claims, skipping transfers already in flight.
    /// Returns dispatches, not confirmed payments. Bound work and callback gas.
    pub fn process_queue(&mut self, max: Option<u32>) -> u32 {
        let limit = (max.unwrap_or(10).min(10) as u64).min(self.queue_ids.len());
        let mut dispatched = 0;
        for _ in 0..limit {
            let index = self.queue_cursor % self.queue_ids.len();
            let id = self.queue_ids.as_vector().get(index).expect("active ticket");
            self.queue_cursor = (index + 1) % self.queue_ids.len();
            let mut t = self.queue.get(&id).expect("ticket");
            if t.in_flight || self.liquid < t.amount.0 { continue; }
            t.in_flight = true;
            t.failed = false;
            self.queue.insert(&t.id, &t);
            self.liquid -= t.amount.0;
            self.queue_owed -= t.amount.0;
            Promise::new(t.receiver_id.clone())
                .transfer(NearToken::from_yoctonear(t.amount.0 + t.deposit.0))
                .then(Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15)).on_payout(t.id)).detach();
            dispatched += 1;
        }
        dispatched
    }

    #[private]
    pub fn on_payout(&mut self, #[serializer(borsh)] ticket_id: u64) -> bool {
        let Some(mut t) = self.queue.get(&ticket_id) else { return false; };
        if !t.in_flight { return false; }
        require!(env::promise_results_count() == 1, "InvalidPayoutCallback");
        if promise_ok() {
            self.queue.remove(&ticket_id);
            self.queue_ids.remove(&ticket_id);
            event("ticket_paid", &format!(r#"{{"ticket_id":{},"account_id":"{}","amount":"{}"}}"#, t.id, t.account_id, t.amount.0));
            true
        } else {
            self.liquid += t.amount.0;
            self.queue_owed += t.amount.0;
            t.in_flight = false;
            t.failed = true;
            self.queue.insert(&ticket_id, &t);
            event("ticket_failed", &format!(r#"{{"ticket_id":{ticket_id}}}"#));
            false
        }
    }

    #[payable]
    pub fn recover_payout(&mut self, ticket_id: u64, receiver_id: AccountId) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "AttachOneYocto");
        let mut ticket = self.queue.get(&ticket_id).expect("UnknownTicket");
        require!(env::predecessor_account_id() == ticket.account_id, "PayoutOwnerOnly");
        require!(ticket.failed && !ticket.in_flight, "PayoutNotRecoverable");
        ticket.receiver_id = receiver_id;
        self.queue.insert(&ticket_id, &ticket);
    }

    /// Send the surplus (rewards + fees) that is sitting liquid to the brain.
    /// Never dips into the sell buffer or queued payouts: holders come first.
    pub fn harvest(&mut self) -> U128 {
        require!(self.brain_claim.is_none() && self.creator_claim.is_none(), "HarvestPending");
        let available = self.liquid.saturating_sub(self.queue_owed + self.buffer());
        let pay = self.surplus().min(available);
        require!(pay >= MIN_HARVEST, err::NOTHING);
        self.liquid -= pay;
        let to_creator = self.creator.as_ref().map_or(0, |c| pay * u128::from(c.share_bps) / BPS);
        let to_brain = pay - to_creator;
        if to_brain > 0 {
            self.brain_claim = Some(HarvestClaim { account_id: self.brain.clone(), receiver_id: self.brain.clone(), amount: U128(to_brain), in_flight: false, failed: false });
            self.retry_harvest(false);
        }
        if to_creator > 0 {
            let who = self.creator.as_ref().expect("creator").account_id.clone();
            self.creator_claim = Some(HarvestClaim { account_id: who.clone(), receiver_id: who, amount: U128(to_creator), in_flight: false, failed: false });
            self.retry_harvest(true);
        }
        U128(pay)
    }

    pub fn refund_registration_deposit(&self) -> U128 {
        U128(ONE_NEAR / 250)
    }

    /// Register once with a deposit (0.004 NEAR covers a maximum-length ID).
    /// Actual record storage remains locked; excess becomes withdrawable credit.
    #[payable]
    pub fn register_refund_account(&mut self) -> RefundCredit {
        let owner = env::predecessor_account_id();
        let cost = self.ensure_refund_credit(&owner);
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, err::STORAGE);
        self.credit_refund(&owner, attached - cost);
        self.refund_credits.get(&owner).expect("registered")
    }

    pub fn get_refund_credit(&self, account_id: AccountId) -> Option<RefundCredit> {
        self.refund_credits.get(&account_id)
    }

    /// Refunds accrue separately from bonding-curve reserves. Withdraw explicitly
    /// so a failed destination never destroys the user's claim.
    #[payable]
    pub fn withdraw_refund(&mut self) -> bool {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "AttachOneYocto");
        let owner = env::predecessor_account_id();
        let Some(mut credit) = self.refund_credits.get(&owner) else { return false; };
        if credit.in_flight.0 > 0 || credit.available.0 == 0 { return false; }
        credit.in_flight = credit.available;
        credit.available = U128(0);
        credit.failed = false;
        self.refund_credits.insert(&owner, &credit);
        Promise::new(credit.receiver_id).transfer(NearToken::from_yoctonear(credit.in_flight.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_refund(owner)).detach();
        true
    }

    #[payable]
    pub fn recover_refund(&mut self, receiver_id: AccountId) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "AttachOneYocto");
        let owner = env::predecessor_account_id();
        let mut credit = self.refund_credits.get(&owner).expect("RefundAccountNotRegistered");
        require!(credit.failed && credit.in_flight.0 == 0, "PayoutNotRecoverable");
        credit.receiver_id = receiver_id;
        self.refund_credits.insert(&owner, &credit);
    }

    #[private]
    pub fn on_refund(&mut self, #[serializer(borsh)] owner: AccountId) -> bool {
        let Some(mut credit) = self.refund_credits.get(&owner) else { return false; };
        if credit.in_flight.0 == 0 { return false; }
        require!(env::promise_results_count() == 1, "InvalidPayoutCallback");
        let success = promise_ok();
        if !success { credit.available = U128(credit.available.0 + credit.in_flight.0); credit.failed = true; }
        credit.in_flight = U128(0);
        self.refund_credits.insert(&owner, &credit);
        success
    }

    pub fn get_harvest_claim(&self, creator: bool) -> Option<HarvestClaim> {
        if creator { self.creator_claim.clone() } else { self.brain_claim.clone() }
    }

    /// An unresolved transfer never retries. Only a confirmed failure unlocks it.
    pub fn retry_harvest(&mut self, creator: bool) -> bool {
        let slot = if creator { &mut self.creator_claim } else { &mut self.brain_claim };
        let Some(claim) = slot.as_mut() else { return false; };
        if claim.in_flight { return false; }
        claim.in_flight = true;
        claim.failed = false;
        Promise::new(claim.receiver_id.clone()).transfer(NearToken::from_yoctonear(claim.amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_harvest(creator)).detach();
        true
    }

    #[payable]
    pub fn recover_harvest(&mut self, creator: bool, receiver_id: AccountId) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "AttachOneYocto");
        let slot = if creator { &mut self.creator_claim } else { &mut self.brain_claim };
        let claim = slot.as_mut().expect("UnknownHarvest");
        require!(env::predecessor_account_id() == claim.account_id, "PayoutOwnerOnly");
        require!(claim.failed && !claim.in_flight, "PayoutNotRecoverable");
        claim.receiver_id = receiver_id;
    }

    #[private]
    pub fn on_harvest(&mut self, #[serializer(borsh)] creator: bool) -> bool {
        let slot = if creator { &mut self.creator_claim } else { &mut self.brain_claim };
        let Some(claim) = slot.as_mut() else { return false; };
        if !claim.in_flight { return false; }
        require!(env::promise_results_count() == 1, "InvalidPayoutCallback");
        if !promise_ok() { claim.in_flight = false; claim.failed = true; return false; }
        let amount = claim.amount.0;
        let receiver = claim.receiver_id.clone();
        *slot = None;
        if creator { self.creator_earned += amount; }
        else { self.total_harvested += amount; }
        event(if creator { "creator_harvest" } else { "harvest" }, &format!(r#"{{"receiver":"{receiver}","amount":"{amount}"}}"#));
        true
    }
}

impl ThePit {
    /// Bill the caller for storage this call added; refund the rest of the
    /// deposit. Returns what was kept.
    pub(crate) fn charge_storage(&mut self, before: u64, payer: &AccountId) -> u128 {
        let used = env::storage_usage().saturating_sub(before);
        let cost = u128::from(used) * env::storage_byte_cost().as_yoctonear();
        let registration = self.ensure_refund_credit(payer);
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost + registration, err::STORAGE);
        self.credit_refund(payer, attached - cost - registration);
        cost
    }

    /// Registration storage remains funded for the lifetime of this account's
    /// credit. Small refunds aggregate without allocating one record per refund.
    pub(crate) fn ensure_refund_credit(&mut self, owner: &AccountId) -> u128 {
        if self.refund_credits.contains_key(owner) { return 0; }
        let before = env::storage_usage();
        let mut credit = RefundCredit { storage_paid: U128(0), available: U128(0), in_flight: U128(0), receiver_id: owner.clone(), failed: false };
        self.refund_credits.insert(owner, &credit);
        // Prepay the maximum recipient length so authorized recovery never
        // consumes storage float when redirecting from a short to a long ID.
        let bytes = env::storage_usage() - before + (64 - owner.as_str().len()) as u64;
        let cost = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        credit.storage_paid = U128(cost);
        self.refund_credits.insert(owner, &credit);
        cost
    }

    pub(crate) fn credit_refund(&mut self, owner: &AccountId, amount: u128) {
        if amount == 0 { return; }
        let mut credit = self.refund_credits.get(owner).expect("RefundAccountNotRegistered");
        credit.available = U128(credit.available.0 + amount);
        self.refund_credits.insert(owner, &credit);
    }
}
