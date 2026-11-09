//! # The Pit — coin contract
//!
//! A NEP-141 memecoin with a metabolism. Every coin launched by the factory runs
//! this exact code (published once as a NEAR global contract, pinned by hash).
//!
//! **Economics.** Buys and sells go through a constant-product bonding curve with
//! virtual reserves. The NEAR behind the curve (`principal`) is what the curve owes
//! holders; most of it is staked with fixed validator pools, and a liquid buffer
//! pays sellers immediately. Anything above principal and queued payouts — staking
//! rewards plus the trading fee — is `surplus`, harvested to the coin's brain
//! (its AI budget) and optionally split with the creator.
//!
//! ```text
//!   principal = NEAR owed to holders through the curve
//!   surplus   = liquid + staked + unstaking − principal − queued payouts − margin
//! ```
//!
//! **Launch.** An optional early-access window comes first: a buy needs a
//! short-lived pass, Ed25519-signed by a pinned verifier key or by a Shade Agent
//! the agent registry reports as valid, bound to buyer, sale, epoch, token cap,
//! expiry and a one-use nonce. Per-wallet caps apply per epoch.
//!
//! **Trust.** There is no owner and no admin withdraw. Pools, curve, fee, buffer,
//! launch schedule and verifier keys are fixed at init. The only privileged calls
//! are `set_brain` and `set_thinker`, callable by the current brain account. Keeper
//! methods (`rebalance`, `process_queue`, `harvest`, `retry_harvest`) are
//! permissionless and can only move NEAR between the reserve, the fixed pools,
//! queued sellers, the brain and the creator.
//!
//! | Module | Responsibility |
//! |---|---|
//! | `trading` | Buys, pass-gated buys, sells, curve math |
//! | `payouts` | Sell queue, harvest claims, refund credits |
//! | `staking` | Validator-pool round-trips under a callback-released lock |
//! | `mind` | Holder memories (conviction voting) and Proof of Thought |
//! | `views` | Read-only methods |
//! | `token` | NEP-141 / NEP-145 / NEP-148 |
//! | `types`, `external`, `constants`, `util` | Data types, external interfaces, limits, helpers |

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::{LookupMap, LookupSet, UnorderedSet};
use near_sdk::json_types::U128;
use near_sdk::serde::{de, Deserialize, Deserializer, Serialize};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

mod constants;
mod external;
mod mind;
mod payouts;
mod staking;
mod token;
mod trading;
mod types;
mod util;
mod views;

pub use constants::*;
pub use external::*;
pub use types::*;
pub use util::{valid_icon, valid_name};
pub(crate) use util::*;

// The macro's generated code trips style lints we can't change.
#[allow(clippy::manual_div_ceil, clippy::assign_op_pattern)]
mod wide {
    uint::construct_uint! {
        /// 256-bit intermediate for curve math (reserve × amount overflows u128).
        pub struct U256(4);
    }
}
pub use wide::U256;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ThePit {
    ft: FungibleToken,
    metadata: FungibleTokenMetadata,

    /// Receives the surplus. Can only be changed by itself.
    brain: AccountId,

    /// Curve: NEAR reserve = virtual_near + principal,
    /// token reserve = virtual_tokens − total_supply.
    virtual_near: u128,
    virtual_tokens: u128,
    fee_bps: u16,
    /// Share of principal kept liquid for instant sells.
    buffer_bps: u16,

    principal: u128,
    /// Accounted liquid NEAR. Excludes storage deposits and the account's own
    /// storage float, which are never paid out.
    liquid: u128,
    pools: Vec<PoolState>,
    /// Set while a pool round-trip is in flight; holds its start time.
    lock_ms: Option<u64>,

    queue: LookupMap<u64, Ticket>,
    queue_ids: UnorderedSet<u64>,
    queue_cursor: u64,
    queue_tail: u64,
    queue_owed: u128,
    refund_credits: LookupMap<AccountId, RefundCredit>,
    brain_claim: Option<HarvestClaim>,
    creator_claim: Option<HarvestClaim>,

    tiers: Vec<Tier>,
    total_harvested: u128,
    total_fees: u128,

    launch: Option<LaunchConfig>,
    creator: Option<CreatorCut>,
    creator_earned: u128,

    /// Records Proof-of-Thought entries (the brain service's account).
    thinker: Option<AccountId>,
    memories: LookupMap<u64, Memory>,
    memory_count: u64,
    /// "id|account" → backing.
    backings: LookupMap<String, Backing>,
    /// Adopted memory ids, oldest first (ring of MAX_CANON).
    canon: Vec<u64>,
    /// Hash chain over every adoption: sha256(prev ‖ id ‖ sha256(text)).
    canon_hash: [u8; 32],
    thoughts: LookupMap<u64, Thought>,
    thought_count: u64,
    /// Every NEAR AI response hash ever recorded: a response proves one thought.
    recorded_responses: LookupSet<Vec<u8>>,
    /// sha256 of every pass ever used.
    used_passes: LookupSet<Vec<u8>>,
    /// "account|epoch" → token atoms bought with passes in that epoch.
    gated_bought: LookupMap<String, u128>,
}

#[near]
impl ThePit {
    #[init]
    #[allow(clippy::too_many_arguments)]
    /// Init args are Borsh, in this order (the factory encodes them): a JSON
    /// parser for every config type would cost ~20 KB of code that runs once.
    pub fn new(
        #[serializer(borsh)] brain: AccountId,
        #[serializer(borsh)] pools: Vec<AccountId>,
        #[serializer(borsh)] virtual_near: U128,
        #[serializer(borsh)] virtual_tokens: U128,
        #[serializer(borsh)] fee_bps: u16,
        #[serializer(borsh)] buffer_bps: u16,
        #[serializer(borsh)] tiers: Vec<Tier>,
        #[serializer(borsh)] name: String,
        #[serializer(borsh)] symbol: String,
        #[serializer(borsh)] icon: Option<String>,
        #[serializer(borsh)] launch: Option<LaunchConfig>,
        #[serializer(borsh)] creator: Option<CreatorCut>,
        #[serializer(borsh)] thinker: Option<AccountId>,
    ) -> Self {
        if let Some(c) = &creator {
            require!(c.share_bps <= MAX_CREATOR_SHARE_BPS, err::BAD_CONFIG);
        }
        if let Some(l) = &launch {
            require!(!l.sale_id.is_empty() && l.sale_id.len() <= 64, err::BAD_CONFIG);
            require!(
                !l.gated_epochs.is_empty() && l.gated_epochs.len() <= MAX_GATED_EPOCHS,
                err::BAD_CONFIG
            );
            let mut prev = l.starts_at_ms;
            for e in &l.gated_epochs {
                require!(e.ends_at_ms > prev && e.per_buyer_max_tokens.0 > 0, err::BAD_CONFIG);
                prev = e.ends_at_ms;
            }
            require!(
                (!l.verifiers.is_empty() || l.agent_registry.is_some())
                    && l.verifiers.len() <= MAX_VERIFIERS,
                err::BAD_CONFIG
            );
            for v in &l.verifiers {
                require!(decode_key(&v.pubkey_hex).is_some() && safe_name(&v.name), err::BAD_CONFIG);
            }
        }
        require!(!pools.is_empty() && pools.len() <= MAX_POOLS, err::BAD_CONFIG);
        for (i, p) in pools.iter().enumerate() {
            require!(!pools[..i].contains(p), err::BAD_CONFIG);
        }
        require!(virtual_near.0 >= ONE_NEAR && virtual_tokens.0 >= ONE_TOKEN, err::BAD_CONFIG);
        require!(fee_bps <= MAX_FEE_BPS, err::BAD_CONFIG);
        require!(
            (MIN_BUFFER_BPS..=10_000).contains(&buffer_bps),
            err::BAD_CONFIG
        );
        require!(
            !tiers.is_empty()
                && tiers[0].min_principal.0 == 0
                && tiers.windows(2).all(|w| w[0].min_principal.0 < w[1].min_principal.0),
            err::BAD_CONFIG
        );

        require!(valid_name(&name) && valid_name(&symbol) && symbol.len() <= 16, err::BAD_NAME);
        require!(icon.as_deref().is_none_or(valid_icon), err::BAD_ICON);
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        };
        metadata.assert_valid();

        let mut this = Self {
            ft: FungibleToken::new(b"t".to_vec()),
            metadata,
            brain,
            virtual_near: virtual_near.0,
            virtual_tokens: virtual_tokens.0,
            fee_bps,
            buffer_bps,
            principal: 0,
            liquid: 0,
            pools: pools
                .into_iter()
                .map(|account_id| PoolState {
                    account_id,
                    staked: U128(0),
                    unstaked: U128(0),
                    can_withdraw: false,
                    synced_ms: 0,
                })
                .collect(),
            lock_ms: None,
            queue: LookupMap::new(b"q".to_vec()),
            queue_ids: UnorderedSet::new(b"qi".to_vec()),
            queue_cursor: 0,
            queue_tail: 0,
            queue_owed: 0,
            refund_credits: LookupMap::new(b"rc".to_vec()),
            brain_claim: None,
            creator_claim: None,
            tiers,
            total_harvested: 0,
            total_fees: 0,
            launch,
            creator,
            creator_earned: 0,
            thinker,
            memories: LookupMap::new(b"m".to_vec()),
            memory_count: 0,
            backings: LookupMap::new(b"b".to_vec()),
            canon: Vec::new(),
            canon_hash: [0u8; 32],
            thoughts: LookupMap::new(b"h".to_vec()),
            thought_count: 0,
            recorded_responses: LookupSet::new(b"r".to_vec()),
            used_passes: LookupSet::new(b"p".to_vec()),
            gated_bought: LookupMap::new(b"g".to_vec()),
        };
        // The contract holds backers' tokens while they back memories.
        this.ft.internal_register_account(&env::current_account_id());
        this
    }

    // ————— roles —————

    /// The brain may hand thinking to another account (e.g. a new TEE agent).
    pub fn set_thinker(&mut self, thinker: Option<AccountId>) {
        require!(env::predecessor_account_id() == self.brain, err::BRAIN_ONLY);
        self.thinker = thinker;
    }
    /// Hand the brain role to another account. Only the brain can do this.
    pub fn set_brain(&mut self, new_brain: AccountId) {
        require!(env::predecessor_account_id() == self.brain, err::BRAIN_ONLY);
        event("brain_changed", &format!(r#"{{"from":"{}","to":"{new_brain}"}}"#, self.brain));
        self.brain = new_brain;
    }
}
