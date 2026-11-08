/*
 * mock-pool — TEST ONLY. Never point a real The Pit deployment at this.
 *
 * Implements the subset of the NEAR core staking-pool interface The Pit uses
 * (deposit_and_stake, unstake, withdraw, get_account) with a configurable
 * unstake delay in milliseconds instead of 4 epochs, plus `add_rewards` so a
 * demo can simulate staking yield on demand.
 */

use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Stake {
    staked: u128,
    unstaked: u128,
    unlock_ms: u64,
}

#[near(serializers = [json])]
pub struct PoolAccount {
    pub account_id: AccountId,
    pub unstaked_balance: U128,
    pub staked_balance: U128,
    pub can_withdraw: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockPool {
    accounts: LookupMap<AccountId, Stake>,
    unstake_delay_ms: u64,
}

#[near]
impl MockPool {
    #[init]
    pub fn new(unstake_delay_ms: u64) -> Self {
        Self { accounts: LookupMap::new(b"a".to_vec()), unstake_delay_ms }
    }

    #[payable]
    pub fn deposit_and_stake(&mut self) {
        let who = env::predecessor_account_id();
        let mut s = self.accounts.get(&who).unwrap_or_default();
        s.staked += env::attached_deposit().as_yoctonear();
        self.accounts.insert(&who, &s);
    }

    pub fn unstake(&mut self, amount: U128) {
        let who = env::predecessor_account_id();
        let mut s = self.accounts.get(&who).expect("NoAccount");
        require!(amount.0 <= s.staked, "NotEnoughStaked");
        s.staked -= amount.0;
        s.unstaked += amount.0;
        s.unlock_ms = env::block_timestamp_ms() + self.unstake_delay_ms;
        self.accounts.insert(&who, &s);
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let mut s = self.accounts.get(&who).expect("NoAccount");
        require!(env::block_timestamp_ms() >= s.unlock_ms, "StillLocked");
        require!(amount.0 <= s.unstaked, "NotEnoughUnstaked");
        s.unstaked -= amount.0;
        self.accounts.insert(&who, &s);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Demo helper: the attached NEAR becomes staking rewards for `account_id`.
    #[payable]
    pub fn add_rewards(&mut self, account_id: AccountId) {
        let mut s = self.accounts.get(&account_id).unwrap_or_default();
        s.staked += env::attached_deposit().as_yoctonear();
        self.accounts.insert(&account_id, &s);
    }

    pub fn get_account(&self, account_id: AccountId) -> PoolAccount {
        let s = self.accounts.get(&account_id).unwrap_or_default();
        PoolAccount {
            account_id,
            unstaked_balance: U128(s.unstaked),
            staked_balance: U128(s.staked),
            can_withdraw: env::block_timestamp_ms() >= s.unlock_ms,
        }
    }
}
