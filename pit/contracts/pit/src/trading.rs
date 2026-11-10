//! Buying and selling on the bonding curve, including pass-gated buys during early-access epochs.

use crate::*;

#[near]
impl ThePit {

    /// Buy with the attached NEAR once the curve is open to everyone.
    /// Registers the buyer if needed (storage cost comes out of the deposit).
    #[payable]
    pub fn buy(&mut self, min_tokens_out: U128) -> U128 {
        match self.phase() {
            Phase::NotStarted => env::panic_str(err::NOT_STARTED),
            Phase::Gated(_) => env::panic_str(err::PASS_REQUIRED),
            Phase::Open => {}
        }
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        U128(
            self.try_settle_buy(&buyer, deposit, min_tokens_out.0, None, "{}".into())
                .unwrap_or_else(|e| env::panic_str(e)),
        )
    }

    /// Buy during a gated epoch with a pass signed by a statically pinned
    /// verifier key. `pass` is the exact signed JSON; `sig_b64` its signature.
    #[payable]
    pub fn buy_with_pass(&mut self, pass: String, sig_b64: String, min_tokens_out: U128) -> U128 {
        let Phase::Gated(epoch) = self.phase() else { env::panic_str(err::NOT_GATED) };
        let buyer = env::predecessor_account_id();
        let sig = decode_sig(&sig_b64);
        let verifier = self
            .launch
            .as_ref()
            .expect("gated phase implies launch")
            .verifiers
            .iter()
            .find(|v| {
                decode_key(&v.pubkey_hex)
                    .is_some_and(|k| env::ed25519_verify(&sig, pass.as_bytes(), &k))
            })
            .unwrap_or_else(|| env::panic_str(err::UNKNOWN_VERIFIER))
            .name
            .clone();

        let (pass_max, nullifier) = self.check_pass(&pass, &buyer, epoch).unwrap_or_else(|e| env::panic_str(e));
        let deposit = env::attached_deposit().as_yoctonear();
        let out = self
            .settle_gated(&buyer, deposit, min_tokens_out.0, epoch, pass_max, format!(r#"{{"epoch":{epoch},"verifier":"{verifier}"}}"#))
            .unwrap_or_else(|e| env::panic_str(e));
        self.used_passes.insert(&nullifier);
        U128(out)
    }

    /// Buy during a gated epoch with a pass signed by Shade Agent `agent_id`.
    /// The signature and pass are checked now; the agent's TEE registration
    /// is checked with the agent contract, and the buy settles in the
    /// callback. If anything fails there, the deposit is refunded. ≥ 100 Tgas.
    #[payable]
    pub fn buy_with_agent_pass(
        &mut self,
        pass: String,
        sig_b64: String,
        agent_id: AccountId,
        min_tokens_out: U128,
    ) -> Promise {
        let Phase::Gated(epoch) = self.phase() else { env::panic_str(err::NOT_GATED) };
        let registry = self
            .launch
            .as_ref()
            .and_then(|l| l.agent_registry.clone())
            .unwrap_or_else(|| env::panic_str(err::NO_REGISTRY));
        let buyer = env::predecessor_account_id();

        // The agent's account id is its public key (implicit account).
        let key = decode_key(agent_id.as_str()).unwrap_or_else(|| env::panic_str(err::NOT_IMPLICIT));
        require!(env::ed25519_verify(&decode_sig(&sig_b64), pass.as_bytes(), &key), err::UNKNOWN_VERIFIER);
        let (pass_max, nullifier) = self.check_pass(&pass, &buyer, epoch).unwrap_or_else(|e| env::panic_str(e));
        let attached = env::attached_deposit().as_yoctonear();
        let storage = self.ensure_refund_credit(&buyer);
        require!(attached > storage + PASS_STORAGE_FEE, err::STORAGE);
        let deposit = attached - storage;
        let expires_at_ms = near_sdk::serde_json::from_str::<PassToken>(&pass)
            .unwrap_or_else(|_| env::panic_str(err::BAD_PASS)).expires_at_ms;

        // Reserve the pass so it can't be used twice while the check is in flight.
        self.used_passes.insert(&nullifier);

        ext_registry::ext(registry)
            .with_static_gas(GAS_REGISTRY_VIEW)
            .get_agent(agent_id.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_AGENT)
                    .on_agent_checked(buyer, U128(deposit), nullifier, epoch, U128(pass_max), min_tokens_out, agent_id, expires_at_ms),
            )
    }

    /// Settles an agent-pass buy, or refunds it. Never panics after the
    /// deposit has arrived: every failure path releases the pass and refunds.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_agent_checked(
        &mut self,
        #[serializer(borsh)] buyer: AccountId,
        #[serializer(borsh)] deposit: U128,
        #[serializer(borsh)] nullifier: Vec<u8>,
        #[serializer(borsh)] epoch: u32,
        #[serializer(borsh)] pass_max: U128,
        #[serializer(borsh)] min_tokens_out: U128,
        #[serializer(borsh)] agent_id: AccountId,
        #[serializer(borsh)] expires_at_ms: u64,
        #[callback_result] agent: Result<Option<AgentCheck>, PromiseError>,
    ) -> U128 {
        let verdict = match agent {
            Err(_) => Err(err::REGISTRY_FAILED),
            Ok(None) => Err(err::AGENT_NOT_REGISTERED),
            Ok(Some(a)) if a.account_id != agent_id || a.validity != AgentValidity::Valid => Err(err::AGENT_INVALID),
            Ok(Some(_)) if self.phase() != Phase::Gated(epoch) => Err(err::WRONG_EPOCH),
            Ok(Some(_)) if expires_at_ms < now_ms() => Err(err::EXPIRED),
            Ok(Some(_)) => self.settle_gated(
                &buyer,
                deposit.0,
                min_tokens_out.0,
                epoch,
                pass_max.0,
                format!(r#"{{"epoch":{epoch},"agent":"{agent_id}"}}"#),
            ),
        };
        match verdict {
            Ok(out) => U128(out),
            Err(reason) => {
                self.used_passes.remove(&nullifier);
                event(
                    "agent_pass_refund_credited",
                    &format!(r#"{{"account_id":"{buyer}","agent":"{agent_id}","reason":"{reason}","refund":"{}"}}"#, deposit.0),
                );
                self.credit_refund(&buyer, deposit.0);
                U128(0)
            }
        }
    }

    /// Sell `amount` tokens. Paid instantly from the liquid buffer, or queued
    /// at today's price if the buffer is short (see `process_queue`). Attach
    /// TICKET_DEPOSIT (including immediately dispatched sells),
    /// which comes back with the payout. The attached deposit is always returned.
    #[payable]
    pub fn sell(&mut self, amount: U128, min_near_out: U128) -> SellResult {
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= 1, err::NEED_DEPOSIT);
        require!(attached >= TICKET_DEPOSIT, err::TICKET_DEPOSIT);
        let seller = env::predecessor_account_id();
        require!(amount.0 > 0, err::ZERO);

        let gross = self.quote_sell_gross(amount.0);
        let fee = self.fee_of(gross);
        let net = gross - fee;
        require!(net > 0 && net >= min_near_out.0, err::SLIPPAGE);
        // Holds by curve math (rounding always favours the reserve); belt and braces.
        require!(gross <= self.principal, "CurveInsolvent");

        self.ft.internal_withdraw(&seller, amount.0);
        FtBurn { owner_id: &seller, amount, memo: Some("sell") }.emit();

        self.principal -= gross;
        self.total_fees += fee;

        // The attached deposit never enters the reserve; it's returned with
        // the payout (and funds the ticket's storage meanwhile).
        let id = self.queue_tail;
        self.queue.insert(&id, &Ticket {
            id, account_id: seller.clone(), amount: U128(net),
            deposit: U128(attached), created_ms: now_ms(), in_flight: false,
            receiver_id: seller.clone(), failed: false,
        });
        let was_empty = self.queue_ids.is_empty();
        self.queue_ids.insert(&id);
        self.queue_tail += 1;
        self.queue_owed += net;
        let dispatched = was_empty && self.process_queue(Some(1)) == 1;
        let result = SellResult {
            status: if dispatched { "paying" } else { "queued" }.into(),
            near_out: U128(net), ticket_id: Some(id),
        };

        event(
            "sell",
            &format!(
                r#"{{"account_id":"{seller}","tokens_in":"{}","fee":"{fee}","status":"{}","near_out":"{net}"}}"#,
                amount.0, result.status
            ),
        );
        result
    }
}

impl ThePit {
    /// Everything a pass binds, except who signed it. Returns the pass's token
    /// cap (atoms) and its nullifier. Doesn't change state.
    pub(crate) fn check_pass(&self, pass: &str, buyer: &AccountId, epoch: u32) -> Result<(u128, Vec<u8>), &'static str> {
        let launch = self.launch.as_ref().ok_or(err::NOT_GATED)?;
        let p: PassToken = near_sdk::serde_json::from_str(pass).map_err(|_| err::BAD_PASS)?;
        if !(p.v == 1 && p.kind == "early_access" && p.nonce.len() >= 32) {
            return Err(err::BAD_PASS);
        }
        if p.sale != launch.sale_id {
            return Err(err::WRONG_SALE);
        }
        if &p.buyer != buyer {
            return Err(err::NOT_FOR_YOU);
        }
        if p.expires_at_ms < now_ms() {
            return Err(err::EXPIRED);
        }
        if p.epoch != epoch {
            return Err(err::WRONG_EPOCH);
        }
        let pass_max = p
            .max_amount
            .parse::<u128>()
            .ok()
            .and_then(|t| t.checked_mul(ONE_TOKEN))
            .filter(|m| *m > 0)
            .ok_or(err::BAD_PASS)?;
        let nullifier = env::sha256(pass.as_bytes());
        if self.used_passes.contains(&nullifier) {
            return Err(err::REPLAY);
        }
        Ok((pass_max, nullifier))
    }

    /// Settle a gated buy within the pass cap and the buyer's epoch cap.
    /// PASS_STORAGE_FEE comes off the deposit and stays as storage float for
    /// the pass nullifier and epoch-cap records this buy creates.
    pub(crate) fn settle_gated(
        &mut self,
        buyer: &AccountId,
        deposit: u128,
        min_tokens_out: u128,
        epoch: u32,
        pass_max: u128,
        extra: String,
    ) -> Result<u128, &'static str> {
        let per_buyer = self.launch.as_ref().ok_or(err::NOT_GATED)?.gated_epochs[epoch as usize]
            .per_buyer_max_tokens
            .0
            .saturating_mul(ONE_TOKEN);
        let key = format!("{buyer}|{epoch}");
        let already = self.gated_bought.get(&key).unwrap_or(0);
        let room = per_buyer.saturating_sub(already);
        let limit = if pass_max <= room { (pass_max, err::PASS_CAP) } else { (room, err::PER_BUYER_CAP) };
        if deposit <= PASS_STORAGE_FEE {
            return Err(err::DEPOSIT_TOO_SMALL);
        }
        let out = self.try_settle_buy(buyer, deposit - PASS_STORAGE_FEE, min_tokens_out, Some(limit), extra)?;
        self.gated_bought.insert(&key, &(already + out));
        Ok(out)
    }

    /// Validate everything, then mint. `limit` is (max tokens out, error label).
    /// Returns an error without changing state if any check fails.
    pub(crate) fn try_settle_buy(
        &mut self,
        buyer: &AccountId,
        deposit: u128,
        min_tokens_out: u128,
        limit: Option<(u128, &'static str)>,
        extra: String,
    ) -> Result<u128, &'static str> {
        let mut attached = deposit;
        let register = !self.ft.accounts.contains_key(buyer);
        if register {
            let cost = self.ft.storage_balance_bounds().min.as_yoctonear();
            if attached <= cost {
                return Err(err::DEPOSIT_TOO_SMALL);
            }
            attached -= cost;
        }
        if attached == 0 {
            return Err(err::ZERO);
        }

        let fee = self.fee_of(attached);
        let net = attached - fee;
        let out = self.quote_buy_net(net);
        if out == 0 || out < min_tokens_out {
            return Err(err::SLIPPAGE);
        }
        if let Some((max, label)) = limit {
            if out > max {
                return Err(label);
            }
        }

        if register {
            self.ft.internal_register_account(buyer);
        }
        self.principal += net;
        self.liquid += attached;
        self.total_fees += fee;
        self.ft.internal_deposit(buyer, out);

        FtMint { owner_id: buyer, amount: U128(out), memo: Some("buy") }.emit();
        event(
            "buy",
            &format!(r#"{{"account_id":"{buyer}","near_in":"{attached}","fee":"{fee}","tokens_out":"{out}","gate":{extra}}}"#),
        );
        Ok(out)
    }

    pub(crate) fn phase_label(&self) -> (&'static str, Option<u32>) {
        match self.phase() {
            Phase::NotStarted => ("not_started", None),
            Phase::Gated(i) => ("gated", Some(i)),
            Phase::Open => ("open", None),
        }
    }

    pub(crate) fn phase(&self) -> Phase {
        let Some(l) = &self.launch else { return Phase::Open };
        let now = now_ms();
        if now < l.starts_at_ms {
            return Phase::NotStarted;
        }
        match l.gated_epochs.iter().position(|e| now < e.ends_at_ms) {
            Some(i) => Phase::Gated(i as u32),
            None => Phase::Open,
        }
    }

    pub(crate) fn fee_of(&self, x: u128) -> u128 {
        x * u128::from(self.fee_bps) / BPS
    }

    pub(crate) fn near_reserve(&self) -> u128 {
        self.virtual_near + self.principal
    }

    pub(crate) fn token_reserve(&self) -> u128 {
        self.virtual_tokens - self.ft.total_supply
    }

    pub(crate) fn quote_buy_net(&self, net: u128) -> u128 {
        mul_div(self.token_reserve(), net, self.near_reserve() + net)
    }

    pub(crate) fn quote_sell_gross(&self, amount: u128) -> u128 {
        mul_div(self.near_reserve(), amount, self.token_reserve() + amount)
    }
}
