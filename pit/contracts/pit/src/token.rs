//! NEP-141 fungible token, NEP-145 storage management and NEP-148 metadata.

use crate::*;

#[near]
impl FungibleTokenCore for ThePit {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        // The contract's own balance holds memory backings; don't mix strays in.
        require!(receiver_id != env::current_account_id(), err::SELF_TRANSFER);
        self.ft.ft_transfer(receiver_id, amount, memo);
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(receiver_id != env::current_account_id(), err::SELF_TRANSFER);
        self.ft.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        U128(self.ft.total_supply)
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.ft.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for ThePit {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.ft.ft_resolve_transfer(sender_id, previous_owner_id, amount)
    }
}

#[near]
impl StorageManagement for ThePit {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only; // This token supports registration only.
        let owner = env::predecessor_account_id();
        let target = account_id.unwrap_or_else(|| owner.clone());
        let attached = env::attached_deposit().as_yoctonear();
        let cost = if self.ft.accounts.contains_key(&target) { 0 } else { self.ft.storage_balance_bounds().min.as_yoctonear() };
        require!(attached >= cost, err::STORAGE);
        if cost > 0 { self.ft.internal_register_account(&target); }
        let excess = attached - cost;
        if excess > 0 {
            if self.refund_credits.contains_key(&owner) || excess > ONE_NEAR / 100 {
                // Kept as a withdrawable credit, so a failed transfer can't lose it.
                let registration = self.ensure_refund_credit(&owner);
                self.credit_refund(&owner, excess - registration);
            } else {
                // A small overpayment (wallets often round up) comes straight
                // back, as NEP-145 expects, instead of failing the call.
                Promise::new(owner).transfer(NearToken::from_yoctonear(excess)).detach();
            }
        }
        self.ft.storage_balance_of(target).expect("registered")
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.ft.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Force-unregister would burn tokens without paying their curve value.
        require!(!force.unwrap_or(false), "ForceUnregisterDisabled");
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "AttachOneYocto");
        let owner = env::predecessor_account_id();
        let Some(balance) = self.ft.accounts.get(&owner) else { return false; };
        require!(balance == 0, "PositiveTokenBalance");
        // Register this separately if the account only used exact-minimum
        // NEP-145 registration. Its collateral cannot subsidize a new ledger.
        require!(self.refund_credits.contains_key(&owner), "RegisterRefundAccountFirst");
        self.ft.accounts.remove(&owner);
        self.credit_refund(&owner, self.ft.storage_balance_bounds().min.as_yoctonear() + 1);
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.ft.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.ft.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for ThePit {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}
