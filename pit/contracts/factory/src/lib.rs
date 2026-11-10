/*
 * The Pit launchpad factory.
 *
 * Anyone calls `create_coin` and gets `<symbol>.<factory>`: a memecoin with a
 * optional early-access launch whose staked reserve feeds its own AI brain. Every coin
 * runs the same code, published once as a NEAR *global contract* and pinned
 * by hash, so a new coin costs a small storage float instead of a full copy of
 * the code — and no coin's code can ever be swapped out.
 *
 * No owner. Everything is fixed at init: the pinned code hash, the shared
 * brain account, validator pools, the launch gate (Shade agent registry and/or
 * pinned keys) and the curve defaults. Creators choose name, symbol, icon,
 * launch schedule and their cut of the brain's food (≤ 50%).
 */

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{U128, U64};
use near_sdk::borsh::BorshSerialize;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult,
};

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Kept by the factory to store the coin's registry record. Image icons live
/// only in the coin's own metadata, so the record stays small.
pub const RECORD_FEE: u128 = ONE_NEAR / 50;
/// Failed launches retain this storage fee to fund a recoverable refund claim.
/// Successful-launch excess refunds are covered by RECORD_FEE instead.
pub const REFUND_STORAGE_FEE: u128 = ONE_NEAR / 500;
/// Global contract storage is burned at 10× the normal per-byte storage rate.
pub const GLOBAL_PRICE_MULTIPLIER: u128 = 10;
const STORAGE_PRICE_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// Matches the coin contract: an emoji, or a PNG/JPEG/WebP/GIF data URL ≤ 16 KB.
pub const MAX_ICON_BYTES: usize = 16_384;
/// Icons up to this size (emoji) are copied into the registry record.
pub const MAX_RECORD_ICON_BYTES: usize = 32;
pub const MAX_LAUNCH_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
pub const MIN_EPOCH_MS: u64 = 60_000;
pub const MAX_EPOCHS: usize = 4;
pub const MAX_CREATOR_SHARE_BPS: u16 = 5_000;

const GAS_COIN_INIT: Gas = Gas::from_tgas(40);
const GAS_ON_CREATED: Gas = Gas::from_tgas(40);
const GAS_ON_REFUND: Gas = Gas::from_tgas(10);
const GAS_ON_PUBLISHED: Gas = Gas::from_tgas(10);

mod err {
    pub const NOT_PUBLISHED: &str = "CoinCodeNotPublished";
    pub const PUBLISHED: &str = "CoinCodeAlreadyPublished";
    pub const WRONG_CODE: &str = "CodeHashMismatch";
    pub const BAD_SYMBOL: &str = "BadSymbol";
    pub const TAKEN: &str = "SymbolTaken";
    pub const BAD_NAME: &str = "BadName";
    pub const BAD_ICON: &str = "BadIcon";
    pub const BAD_LAUNCH: &str = "BadLaunchPlan";
    pub const NO_GATE: &str = "NoGateConfigured";
    pub const BAD_SHARE: &str = "CreatorShareTooHigh";
    pub const DEPOSIT: &str = "AttachCreateDeposit";
    pub const BAD_CONFIG: &str = "BadConfig";
}

// ————— types shared with the coin contract (JSON only) —————

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tier {
    pub name: String,
    pub min_principal: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VerifierKey {
    pub pubkey_hex: String,
    pub name: String,
    pub evidence_hash_hex: String,
}

/// Curve and economics every coin launches with.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CoinDefaults {
    pub virtual_near: U128,
    pub virtual_tokens: U128,
    pub fee_bps: u16,
    pub buffer_bps: u16,
    pub tiers: Vec<Tier>,
}

/// A creator's launch schedule: early-access epochs, then open to everyone.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LaunchPlan {
    /// Delay before anyone can buy (≤ 7 days).
    pub starts_in_ms: U64,
    /// 1–4 early-access epochs.
    pub epochs: Vec<EpochPlan>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EpochPlan {
    pub duration_ms: U64,
    pub per_buyer_max_tokens: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CoinRecord {
    pub symbol: String,
    pub account_id: AccountId,
    pub name: String,
    /// Emoji icons only; `has_image` means the image is in the coin's `ft_metadata`.
    pub icon: Option<String>,
    pub has_image: bool,
    pub creator: AccountId,
    pub creator_share_bps: u16,
    pub created_ms: u64,
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub coin_code_hash: String,
    pub code_published: bool,
    pub brain: AccountId,
    pub thinker: Option<AccountId>,
    pub pools: Vec<AccountId>,
    pub agent_registry: Option<AccountId>,
    pub verifiers: Vec<VerifierKey>,
    pub defaults: CoinDefaults,
    pub coin_deposit: U128,
    pub create_cost: U128,
    pub coin_count: u64,
}

/// The coin contract's `new` arguments (see contracts/pit), Borsh-encoded:
/// field order and types must match its parameter list exactly.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct CoinInit<'a> {
    brain: &'a AccountId,
    pools: &'a [AccountId],
    virtual_near: U128,
    virtual_tokens: U128,
    fee_bps: u16,
    buffer_bps: u16,
    tiers: &'a [Tier],
    name: &'a str,
    symbol: String,
    icon: Option<&'a str>,
    launch: Option<CoinLaunch<'a>>,
    creator: Option<CoinCreator<'a>>,
    thinker: Option<&'a AccountId>,
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct CoinLaunch<'a> {
    sale_id: String,
    starts_at_ms: u64,
    gated_epochs: Vec<CoinEpoch>,
    verifiers: &'a [VerifierKey],
    agent_registry: Option<&'a AccountId>,
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct CoinEpoch {
    ends_at_ms: u64,
    per_buyer_max_tokens: U128,
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct CoinCreator<'a> {
    account_id: &'a AccountId,
    share_bps: u16,
}

#[near(serializers = [borsh])]
struct PendingLaunch {
    record: CoinRecord,
    attached: u128,
    cost: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RefundClaim {
    pub id: U64,
    pub account_id: AccountId,
    pub amount: U128,
    pub in_flight: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PitFactory {
    coin_code_hash: [u8; 32],
    code_published: bool,
    brain: AccountId,
    /// Records Proof-of-Thought entries on every coin (the brain service).
    thinker: Option<AccountId>,
    pools: Vec<AccountId>,
    agent_registry: Option<AccountId>,
    verifiers: Vec<VerifierKey>,
    defaults: CoinDefaults,
    /// Sent to each new coin account: its storage float.
    coin_deposit: u128,
    coins: Vector<CoinRecord>,
    by_symbol: LookupMap<String, u64>,
    pending_launches: LookupMap<u64, PendingLaunch>,
    refunds: LookupMap<u64, RefundClaim>,
    next_launch_id: u64,
}

#[allow(deprecated)]
fn promise_ok() -> bool {
    env::promise_results_count() == 1 && matches!(env::promise_result(0), PromiseResult::Successful(_))
}

/// 2–10 chars, lowercase letters and digits, starting with a letter.
fn valid_symbol(s: &str) -> bool {
    (2..=10).contains(&s.len())
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Display text: no control, zero-width, bidi-override or soft-hyphen characters.
fn clean_text(s: &str) -> bool {
    !s.chars().any(|c| {
        c.is_control() || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}')
    })
}

/// An emoji/short text icon, or a raster image data URL (no SVG: it can carry script).
fn valid_icon(icon: &str) -> bool {
    if icon.len() > MAX_ICON_BYTES {
        return false;
    }
    if let Some(rest) = icon.strip_prefix("data:image/") {
        let b64 = ["png", "jpeg", "webp", "gif"]
            .iter()
            .find_map(|t| rest.strip_prefix(t).and_then(|r| r.strip_prefix(";base64,")));
        return b64.is_some_and(|b| !b.is_empty() && b.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')));
    }
    !icon.trim().is_empty() && icon.len() <= MAX_RECORD_ICON_BYTES && !icon.contains([':', '<']) && clean_text(icon)
}

#[near]
impl PitFactory {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        coin_code_hash_hex: String,
        brain: AccountId,
        thinker: Option<AccountId>,
        pools: Vec<AccountId>,
        agent_registry: Option<AccountId>,
        verifiers: Vec<VerifierKey>,
        defaults: CoinDefaults,
        coin_deposit: U128,
    ) -> Self {
        let hash: [u8; 32] = hex::decode(&coin_code_hash_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str(err::BAD_CONFIG));
        require!(!pools.is_empty() && pools.len() <= 4, err::BAD_CONFIG);
        // Reject immutable configurations that the pinned coin's init rejects.
        // Otherwise the factory can publish successfully but never launch coins.
        require!(pools.iter().enumerate().all(|(i, p)| !pools[..i].contains(p)), err::BAD_CONFIG);
        require!(defaults.virtual_near.0 >= ONE_NEAR && defaults.virtual_tokens.0 >= 1_000_000_000_000_000_000, err::BAD_CONFIG);
        require!(defaults.fee_bps <= 500 && (1_000..=10_000).contains(&defaults.buffer_bps), err::BAD_CONFIG);
        require!(
            !defaults.tiers.is_empty()
                && defaults.tiers[0].min_principal.0 == 0
                && defaults.tiers.windows(2).all(|pair| pair[0].min_principal.0 < pair[1].min_principal.0),
            err::BAD_CONFIG
        );
        require!(coin_deposit.0 >= ONE_NEAR / 20, err::BAD_CONFIG);
        Self {
            coin_code_hash: hash,
            code_published: false,
            brain,
            thinker,
            pools,
            agent_registry,
            verifiers,
            defaults,
            coin_deposit: coin_deposit.0,
            coins: Vector::new(b"c".to_vec()),
            by_symbol: LookupMap::new(b"s".to_vec()),
            pending_launches: LookupMap::new(b"l".to_vec()),
            refunds: LookupMap::new(b"r".to_vec()),
            next_launch_id: 0,
        }
    }

    /// Publish the coin code as a global contract. Anyone may call it, but
    /// only with the exact code pinned at init, and only once. The caller
    /// funds the burn (10× the per-byte storage price).
    #[payable]
    pub fn publish_coin_code(&mut self, #[serializer(borsh)] code: Vec<u8>) -> Promise {
        require!(!self.code_published, err::PUBLISHED);
        require!(env::sha256_array(&code) == self.coin_code_hash, err::WRONG_CODE);
        let cost = code.len() as u128 * STORAGE_PRICE_PER_BYTE * GLOBAL_PRICE_MULTIPLIER;
        require!(env::attached_deposit().as_yoctonear() >= cost, err::DEPOSIT);
        Promise::new(env::current_account_id())
            .deploy_global_contract(code)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PUBLISHED).on_published())
    }

    #[private]
    pub fn on_published(&mut self) -> bool {
        let ok = promise_ok();
        if ok {
            self.code_published = true;
            env::log_str("EVENT_JSON:{\"standard\":\"pit-factory\",\"version\":\"1.0.0\",\"event\":\"code_published\",\"data\":[{}]}");
        }
        ok
    }

    /// Launch a coin. Attach `create_cost` (coin storage float + record fee);
    /// anything extra is refunded. Failed launches retain REFUND_STORAGE_FEE. The new coin lives at `<symbol>.<factory>`.
    /// Call with ≥ 100 Tgas.
    #[payable]
    pub fn create_coin(
        &mut self,
        symbol: String,
        name: String,
        icon: Option<String>,
        launch: Option<LaunchPlan>,
        creator_share_bps: u16,
    ) -> Promise {
        require!(self.code_published, err::NOT_PUBLISHED);
        require!(valid_symbol(&symbol), err::BAD_SYMBOL);
        require!(!self.by_symbol.contains_key(&symbol), err::TAKEN);
        let name = name.trim().to_string();
        require!(!name.is_empty() && name.chars().count() <= 32 && clean_text(&name), err::BAD_NAME);
        require!(icon.as_deref().is_none_or(valid_icon), err::BAD_ICON);
        require!(creator_share_bps <= MAX_CREATOR_SHARE_BPS, err::BAD_SHARE);
        let icon_bytes = icon.as_ref().map_or(0, String::len) as u32;
        let cost = self.create_cost(Some(icon_bytes)).0;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, err::DEPOSIT);

        let creator = env::predecessor_account_id();
        let account_id: AccountId = format!("{symbol}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str(err::BAD_SYMBOL));
        let upper = symbol.to_ascii_uppercase();
        let gated = launch.map(|plan| self.launch_config(&upper, plan));

        let init = CoinInit {
            brain: &self.brain,
            pools: &self.pools,
            virtual_near: self.defaults.virtual_near,
            virtual_tokens: self.defaults.virtual_tokens,
            fee_bps: self.defaults.fee_bps,
            buffer_bps: self.defaults.buffer_bps,
            tiers: &self.defaults.tiers,
            name: &name,
            symbol: upper,
            icon: icon.as_deref(),
            launch: gated,
            creator: (creator_share_bps > 0).then_some(CoinCreator { account_id: &creator, share_bps: creator_share_bps }),
            thinker: self.thinker.as_ref(),
        };
        let args = near_sdk::borsh::to_vec(&init).expect("init args serialize");

        let has_image = icon.as_ref().is_some_and(|i| i.len() > MAX_RECORD_ICON_BYTES);
        let record = CoinRecord {
            symbol,
            account_id: account_id.clone(),
            name,
            icon: if has_image { None } else { icon },
            has_image,
            creator,
            creator_share_bps,
            created_ms: env::block_timestamp_ms(),
        };
        let launch_id = self.next_launch_id;
        self.next_launch_id = self.next_launch_id.checked_add(1).expect("LaunchIdOverflow");
        self.pending_launches.insert(&launch_id, &PendingLaunch { record, attached, cost });
        env::log_str(&format!(r#"EVENT_JSON:{{"standard":"pit-factory","version":"1.0.0","event":"launch_started","data":[{{"launch_id":"{launch_id}"}}]}}"#));
        Promise::new(account_id)
            .create_account()
            // The coin pays for its own copy of the icon in its metadata.
            .transfer(NearToken::from_yoctonear(cost - RECORD_FEE))
            .use_global_contract(self.coin_code_hash)
            .function_call("new", args, NearToken::from_yoctonear(0), GAS_COIN_INIT)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CREATED)
                    .on_coin_created(U64(launch_id)),
            )
    }

    /// Records a successful launch; failed launches retain REFUND_STORAGE_FEE.
    /// Refund claims remain until a transfer callback confirms payment.
    #[private]
    pub fn on_coin_created(&mut self, launch_id: U64) -> PromiseOrValue<bool> {
        let Some(pending) = self.pending_launches.get(&launch_id.0) else { return PromiseOrValue::Value(false); };
        require!(env::promise_results_count() == 1, "InvalidLaunchCallback");
        let ok = promise_ok();
        self.pending_launches.remove(&launch_id.0);
        let record = pending.record;
        let refund = if ok { pending.attached - pending.cost } else { pending.attached - REFUND_STORAGE_FEE };
        if ok {
            self.by_symbol.insert(&record.symbol, &self.coins.len());
            env::log_str(&format!(
                r#"EVENT_JSON:{{"standard":"pit-factory","version":"1.0.0","event":"coin_created","data":[{{"symbol":"{}","account_id":"{}","creator":"{}"}}]}}"#,
                record.symbol, record.account_id, record.creator
            ));
            self.coins.push(&record);
        }
        if refund > 0 {
            self.refunds.insert(&launch_id.0, &RefundClaim {
                id: launch_id, account_id: record.creator, amount: U128(refund), in_flight: false,
            });
            env::log_str(&format!(r#"EVENT_JSON:{{"standard":"pit-factory","version":"1.0.0","event":"refund_created","data":[{{"launch_id":"{}","amount":"{refund}"}}]}}"#, launch_id.0));
            // If the float can't cover it yet, the claim waits for retry_refund.
            if let Some(promise) = self.dispatch_refund(launch_id, Some(ok)) {
                return PromiseOrValue::Promise(promise);
            }
        }
        PromiseOrValue::Value(ok)
    }

    /// Send a refund that is not in flight: one whose transfer failed, or one
    /// that waited for a failed launch's funds to return. Anyone may call it;
    /// the destination is fixed to the creator.
    /// An unknown callback never permits a timeout-based retry or duplicate payout.
    pub fn retry_refund(&mut self, launch_id: U64) -> bool {
        if let Some(promise) = self.dispatch_refund(launch_id, None) {
            promise.detach();
            true
        } else { false }
    }

    fn dispatch_refund(&mut self, launch_id: U64, launch_ok: Option<bool>) -> Option<Promise> {
        let mut claim = self.refunds.get(&launch_id.0)?;
        if claim.in_flight { return None; }
        // A failed launch's funds come back from the child in a separate
        // receipt that can land after this. Never spend the storage float:
        // if it isn't covered yet, the claim stays retryable (retry_refund).
        let locked = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        if env::account_balance().as_yoctonear().saturating_sub(locked) < claim.amount.0 + ONE_NEAR / 100 {
            return None;
        }
        claim.in_flight = true;
        self.refunds.insert(&launch_id.0, &claim);
        let transfer = Promise::new(claim.account_id).transfer(NearToken::from_yoctonear(claim.amount.0));
        let callback = Self::ext(env::current_account_id()).with_static_gas(GAS_ON_REFUND);
        Some(transfer.then(match launch_ok {
            Some(ok) => callback.on_launch_refund(launch_id, ok),
            None => callback.on_refund(launch_id),
        }))
    }

    /// Preserve the coin creation result while awaiting the initial refund.
    #[private]
    pub fn on_launch_refund(&mut self, launch_id: U64, launch_ok: bool) -> bool {
        self.on_refund(launch_id);
        launch_ok
    }

    #[private]
    pub fn on_refund(&mut self, launch_id: U64) -> bool {
        let Some(mut claim) = self.refunds.get(&launch_id.0) else { return false; };
        if !claim.in_flight { return false; }
        require!(env::promise_results_count() == 1, "InvalidRefundCallback");
        if promise_ok() {
            self.refunds.remove(&launch_id.0);
            true
        } else {
            claim.in_flight = false;
            self.refunds.insert(&launch_id.0, &claim);
            false
        }
    }

    pub fn get_refund(&self, launch_id: U64) -> Option<RefundClaim> {
        self.refunds.get(&launch_id.0)
    }

    /// Monitor a launch without resetting any unknown in-flight operation.
    pub fn get_launch_status(&self, launch_id: U64) -> String {
        if self.pending_launches.contains_key(&launch_id.0) { "creating" }
        else if let Some(claim) = self.refunds.get(&launch_id.0) {
            if claim.in_flight { "refunding" } else { "refund_retryable" }
        } else if launch_id.0 < self.next_launch_id { "settled" }
        else { "unknown" }.into()
    }

    // ————— views —————

    /// NEAR to attach to `create_coin` for an icon of `icon_bytes` bytes.
    pub fn create_cost(&self, icon_bytes: Option<u32>) -> U128 {
        U128(self.coin_deposit + RECORD_FEE + u128::from(icon_bytes.unwrap_or(0)) * STORAGE_PRICE_PER_BYTE)
    }

    pub fn get_config(&self) -> FactoryConfig {
        FactoryConfig {
            coin_code_hash: hex::encode(self.coin_code_hash),
            code_published: self.code_published,
            brain: self.brain.clone(),
            thinker: self.thinker.clone(),
            pools: self.pools.clone(),
            agent_registry: self.agent_registry.clone(),
            verifiers: self.verifiers.clone(),
            defaults: self.defaults.clone(),
            coin_deposit: U128(self.coin_deposit),
            create_cost: self.create_cost(None),
            coin_count: self.coins.len(),
        }
    }

    /// Newest first.
    pub fn get_coins(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<CoinRecord> {
        let n = self.coins.len();
        let from = from_index.unwrap_or(0).min(n);
        let limit = limit.unwrap_or(50).min(100);
        (from..n.min(from.saturating_add(limit))).filter_map(|i| self.coins.get(n - 1 - i)).collect()
    }

    pub fn get_coin(&self, symbol: String) -> Option<CoinRecord> {
        self.by_symbol.get(&symbol).and_then(|i| self.coins.get(i))
    }

    pub fn coin_count(&self) -> u64 {
        self.coins.len()
    }

    // ————— internal —————

    fn launch_config(&self, upper_symbol: &str, plan: LaunchPlan) -> CoinLaunch<'_> {
        require!(self.agent_registry.is_some() || !self.verifiers.is_empty(), err::NO_GATE);
        require!(plan.starts_in_ms.0 <= MAX_LAUNCH_DELAY_MS, err::BAD_LAUNCH);
        require!(!plan.epochs.is_empty() && plan.epochs.len() <= MAX_EPOCHS, err::BAD_LAUNCH);
        let starts_at_ms = env::block_timestamp_ms() + plan.starts_in_ms.0;
        let mut end = starts_at_ms;
        let gated_epochs = plan
            .epochs
            .into_iter()
            .map(|e| {
                require!(
                    (MIN_EPOCH_MS..=MAX_LAUNCH_DELAY_MS).contains(&e.duration_ms.0) && e.per_buyer_max_tokens.0 > 0,
                    err::BAD_LAUNCH
                );
                end += e.duration_ms.0;
                CoinEpoch { ends_at_ms: end, per_buyer_max_tokens: e.per_buyer_max_tokens }
            })
            .collect();
        CoinLaunch {
            sale_id: format!("PIT-{upper_symbol}"),
            starts_at_ms,
            gated_epochs,
            verifiers: &self.verifiers,
            agent_registry: self.agent_registry.as_ref(),
        }
    }
}
