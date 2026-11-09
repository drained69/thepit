//! Interfaces of the contracts a coin calls: validator staking pools and the Shade agent registry.

use crate::*;

/// The NEAR core staking-pool interface (subset).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PoolAccount {
    pub account_id: AccountId,
    pub unstaked_balance: U128,
    pub staked_balance: U128,
    pub can_withdraw: bool,
}

#[ext_contract(ext_pool)]
#[allow(dead_code)]
trait StakingPool {
    fn deposit_and_stake(&mut self);
    fn unstake(&mut self, amount: U128);
    fn withdraw(&mut self, amount: U128);
    fn get_account(&self, account_id: AccountId) -> PoolAccount;
    #[cfg(feature = "rnear-experimental")]
    fn get_account_details(&self, account_id: AccountId) -> PoolAccount;
}

#[cfg(feature = "rnear-experimental")]
fn is_rnear_pool(account: &AccountId) -> bool {
    matches!(account.as_str(), "lst.rhealab.near" | "lst.ref-dev.testnet")
}

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait AgentRegistry {
    fn get_agent(&self, account_id: AccountId) -> Option<AgentCheck>;
}

