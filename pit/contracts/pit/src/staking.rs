//! Keeping the reserve staked: one validator-pool round-trip at a time, under a lock only callbacks release.

use crate::*;

#[near]
impl ThePit {
    /// Sync one pool and take at most one action on it: withdraw matured
    /// unstakes, stake excess liquid, or unstake to refill the buffer, queue
    /// and harvestable surplus. Call with ≥ 200 Tgas.
    pub fn rebalance(&mut self, pool_index: u32) -> Promise {
        let i = pool_index as usize;
        require!(i < self.pools.len(), err::BAD_POOL);
        // A delayed receipt can still complete after any timeout. Starting a
        // second round-trip would let its stale callback alter new accounting.
        // Only the operation's callback may release this lock.
        require!(self.lock_ms.is_none(), err::LOCKED);
        self.lock_ms = Some(now_ms());

        let pool = self.pools[i].account_id.clone();
        #[cfg(feature = "rnear-experimental")]
        let query = if is_rnear_pool(&pool) {
            ext_pool::ext(pool).with_static_gas(GAS_POOL_VIEW).get_account_details(env::current_account_id())
        } else {
            ext_pool::ext(pool).with_static_gas(GAS_POOL_VIEW).get_account(env::current_account_id())
        };
        #[cfg(not(feature = "rnear-experimental"))]
        let query = ext_pool::ext(pool).with_static_gas(GAS_POOL_VIEW).get_account(env::current_account_id());
        query.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_POOL_STATE)
                    .on_pool_state(pool_index),
            )
    }

    #[private]
    pub fn on_pool_state(
        &mut self,
        #[serializer(borsh)] pool_index: u32,
        #[callback_result] state: Result<PoolAccount, PromiseError>,
    ) -> PromiseOrValue<String> {
        let i = pool_index as usize;
        let Ok(a) = state else {
            self.lock_ms = None;
            return PromiseOrValue::Value("PoolViewFailed".into());
        };
        // Never account another customer's staking position as this reserve.
        // A malformed pool response must not create harvestable surplus.
        if a.account_id != env::current_account_id() {
            self.lock_ms = None;
            return PromiseOrValue::Value("PoolAccountMismatch".into());
        }
        self.pools[i] = PoolState {
            account_id: self.pools[i].account_id.clone(),
            staked: a.staked_balance,
            unstaked: a.unstaked_balance,
            can_withdraw: a.can_withdraw,
            synced_ms: now_ms(),
        };
        let pool = self.pools[i].account_id.clone();
        let me = env::current_account_id();

        if a.unstaked_balance.0 > 0 && a.can_withdraw {
            let amt = a.unstaked_balance;
            return PromiseOrValue::Promise(
                ext_pool::ext(pool)
                    .with_static_gas(GAS_POOL_ACTION)
                    .withdraw(amt)
                    .then(Self::ext(me).with_static_gas(GAS_ON_POOL_ACTION).on_withdrawn(pool_index, amt)),
            );
        }

        let target = self.target_liquid();
        let pending: u128 = self.pools.iter().map(|p| p.unstaked.0).sum();
        let effective = self.liquid + pending;

        if effective > target {
            let amt = (effective - target).min(self.liquid);
            if amt >= MIN_STAKE {
                self.liquid -= amt;
                return PromiseOrValue::Promise(
                    ext_pool::ext(pool)
                        .with_static_gas(GAS_POOL_ACTION)
                        .with_attached_deposit(NearToken::from_yoctonear(amt))
                        .deposit_and_stake()
                        .then(Self::ext(me).with_static_gas(GAS_ON_POOL_ACTION).on_staked(pool_index, U128(amt))),
                );
            }
        } else if a.unstaked_balance.0 == 0 {
            // Only unstake from a pool with nothing pending: a new unstake would
            // reset the unlock epoch of what's already waiting.
            let amt = (target - effective).min(a.staked_balance.0);
            if amt >= MIN_UNSTAKE {
                return PromiseOrValue::Promise(
                    ext_pool::ext(pool)
                        .with_static_gas(GAS_POOL_ACTION)
                        .unstake(U128(amt))
                        .then(Self::ext(me).with_static_gas(GAS_ON_POOL_ACTION).on_unstaked(pool_index, U128(amt))),
                );
            }
        }
        self.lock_ms = None;
        PromiseOrValue::Value("Balanced".into())
    }

    #[private]
    pub fn on_staked(&mut self, #[serializer(borsh)] pool_index: u32, #[serializer(borsh)] amount: U128) -> bool {
        let ok = promise_ok();
        let p = &mut self.pools[pool_index as usize];
        if ok {
            // rNEAR mints shares with rounding. Until the next authoritative
            // account view, do not count the deposit as harvestable assets.
            #[cfg(feature = "rnear-experimental")]
            if !is_rnear_pool(&p.account_id) { p.staked = U128(p.staked.0 + amount.0); }
            #[cfg(not(feature = "rnear-experimental"))]
            { p.staked = U128(p.staked.0 + amount.0); }
        } else {
            // A failed call refunds the attached deposit to us.
            self.liquid += amount.0;
        }
        self.lock_ms = None;
        event("staked", &format!(r#"{{"pool":"{}","amount":"{}","ok":{ok}}}"#, p.account_id, amount.0));
        ok
    }

    #[private]
    pub fn on_unstaked(&mut self, #[serializer(borsh)] pool_index: u32, #[serializer(borsh)] amount: U128) -> bool {
        let ok = promise_ok();
        let p = &mut self.pools[pool_index as usize];
        if ok {
            p.staked = U128(p.staked.0.saturating_sub(amount.0));
            p.unstaked = U128(p.unstaked.0 + amount.0);
            p.can_withdraw = false;
        }
        self.lock_ms = None;
        event("unstaked", &format!(r#"{{"pool":"{}","amount":"{}","ok":{ok}}}"#, p.account_id, amount.0));
        ok
    }

    #[private]
    pub fn on_withdrawn(&mut self, #[serializer(borsh)] pool_index: u32, #[serializer(borsh)] amount: U128) -> bool {
        let ok = promise_ok();
        let p = &mut self.pools[pool_index as usize];
        if ok {
            p.unstaked = U128(p.unstaked.0.saturating_sub(amount.0));
            self.liquid += amount.0;
        }
        self.lock_ms = None;
        event("withdrawn", &format!(r#"{{"pool":"{}","amount":"{}","ok":{ok}}}"#, p.account_id, amount.0));
        ok
    }
}

impl ThePit {
    /// Assets above what's owed to holders and queued sellers.
    pub(crate) fn surplus(&self) -> u128 {
        let pooled: u128 = self.pools.iter().map(|p| p.staked.0 + p.unstaked.0).sum();
        (self.liquid + pooled).saturating_sub(self.principal + self.queue_owed + SURPLUS_MARGIN)
    }

    /// Liquid NEAR we want on hand: the sell buffer, queued payouts, and the
    /// surplus (so it can be harvested).
    pub(crate) fn target_liquid(&self) -> u128 {
        self.buffer() + self.queue_owed + self.surplus()
    }

    pub(crate) fn buffer(&self) -> u128 {
        self.principal * u128::from(self.buffer_bps) / BPS
    }
}
