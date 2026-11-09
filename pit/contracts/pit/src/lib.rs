/*
 * The Pit — a memecoin with a metabolism.
 *
 * Buys and sells go through a constant-product bonding curve with virtual
 * reserves. The NEAR that backs the curve ("principal") is mostly staked with
 * validator pools; the rest stays liquid so sells can settle instantly.
 *
 *   principal  = NEAR the curve owes back to sellers (liquidity)
 *   surplus    = everything above principal + queued payouts
 *              = staking rewards + trade fees  → the brain's inference budget
 *
 * Launch: an optional gated phase comes first. During gated epochs a buy
 * needs a short-lived pass from the human gate (tee-gate): Ed25519-signed by
 * a verifier key pinned at init — or by a Shade Agent whose TEE attestation
 * the NEAR agent contract has verified — bound to the buyer, sale, epoch,
 * token cap, expiry and a one-use nonce. Snipers without a pass can't buy until the
 * curve opens to everyone. Pass format is byte-compatible with $HUMAN.
 *
 * There is no owner and no admin withdraw. Pools, curve, fee, buffer, launch
 * schedule and verifier keys are fixed at init. The only privileged calls are `set_brain` and
 * `set_thinker`, callable only by the current brain account. Every keeper method (rebalance, process_queue,
 * harvest) is permissionless and can only move NEAR between the reserve, the
 * fixed pools, queued sellers and the brain.
 */

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

// The macro's generated code trips style lints we can't change.
#[allow(clippy::manual_div_ceil, clippy::assign_op_pattern)]
mod wide {
    uint::construct_uint! {
        /// 256-bit intermediate for curve math (reserve × amount overflows u128).
        pub struct U256(4);
    }
}
pub use wide::U256;

/// The Pit uses 18 decimals.
pub const DECIMALS: u8 = 18;
pub const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Fees and buffer are basis points of 10_000.
const BPS: u128 = 10_000;
pub const MAX_FEE_BPS: u16 = 500;
pub const MIN_BUFFER_BPS: u16 = 1_000;

/// Don't bother staking less than 1 NEAR or unstaking less than 0.01 NEAR.
pub const MIN_STAKE: u128 = ONE_NEAR;
pub const MIN_UNSTAKE: u128 = ONE_NEAR / 100;
/// Smallest harvest worth a transfer.
pub const MIN_HARVEST: u128 = ONE_NEAR / 1_000;
/// Held back from surplus to absorb staking-pool share rounding.
pub const SURPLUS_MARGIN: u128 = ONE_NEAR / 1_000;
/// Historical monitoring threshold. Expiry never unlocks an unresolved pool operation.
pub const LOCK_TIMEOUT_MS: u64 = 15 * 60 * 1_000;
pub const MAX_POOLS: usize = 4;
pub const MAX_GATED_EPOCHS: usize = 8;
pub const MAX_VERIFIERS: usize = 5;
/// Storage the contract would otherwise pay per record. Buyers and sellers
/// fund their own records so nobody can drain the contract's storage float.
/// A gated buy keeps PASS_STORAGE_FEE (nullifier + epoch-cap entry); every
/// sell must attach TICKET_DEPOSIT, returned with its confirmed payout.
pub const PASS_STORAGE_FEE: u128 = ONE_NEAR / 500;
pub const TICKET_DEPOSIT: u128 = ONE_NEAR / 250;
/// A coin's creator can take at most half of what's harvested.
pub const MAX_CREATOR_SHARE_BPS: u16 = 5_000;

// ————— the mind: holder-owned memory + Proof of Thought —————
/// A memory is at most one tweet long.
pub const MAX_MEMORY_BYTES: usize = 280;
/// Adopted memories form the canon the brain reads before every thought.
pub const MAX_CANON: usize = 64;
/// A memory is adopted once its backers have held ADOPT_BPS of supply for
/// ADOPT_WINDOW_MS — or any equivalent token × time (e.g. 2% for half as long).
pub const ADOPT_BPS: u128 = 100;
pub const ADOPT_WINDOW_MS: u128 = 3 * 24 * 60 * 60 * 1_000;
/// Proof-of-Thought records kept on-chain (a ring; older ones live in events).
pub const THOUGHT_SLOTS: u64 = 16;
pub const MAX_THOUGHT_BYTES: usize = 600;
/// Adoption needs at least this many tokens × ADOPT_WINDOW_MS, so a tiny early
/// supply can't be cheaply captured.
pub const MIN_ADOPT_TOKENS: u128 = 1_000_000 * ONE_TOKEN;
/// Coin icons: an emoji/short text, or a raster image data URL up to 16 KB.
pub const MAX_ICON_BYTES: usize = 16_384;

// Margins follow NEAR's lockup contract for validator-pool calls.
const GAS_POOL_VIEW: Gas = Gas::from_tgas(20);
const GAS_POOL_ACTION: Gas = Gas::from_tgas(75);
const GAS_ON_POOL_STATE: Gas = Gas::from_tgas(120);
const GAS_ON_POOL_ACTION: Gas = Gas::from_tgas(15);
const GAS_REGISTRY_VIEW: Gas = Gas::from_tgas(15);
const GAS_ON_AGENT: Gas = Gas::from_tgas(40);

/// Error labels — the agent and web page match on them.
mod err {
    pub const SLIPPAGE: &str = "Slippage";
    pub const ZERO: &str = "ZeroAmount";
    pub const DEPOSIT_TOO_SMALL: &str = "DepositBelowStorageCost";
    pub const BRAIN_ONLY: &str = "BrainOnly";
    pub const LOCKED: &str = "PoolOpInFlight";
    pub const BAD_POOL: &str = "UnknownPool";
    pub const NOTHING: &str = "NothingToHarvest";
    pub const BAD_CONFIG: &str = "BadConfig";
    pub const NOT_STARTED: &str = "LaunchNotStarted";
    pub const PASS_REQUIRED: &str = "PassRequired";
    pub const NOT_GATED: &str = "NotInGatedPhase";
    pub const UNKNOWN_VERIFIER: &str = "PassUnknownVerifier";
    pub const BAD_PASS: &str = "PassMalformed";
    pub const WRONG_SALE: &str = "PassWrongSale";
    pub const NOT_FOR_YOU: &str = "PassNotForYou";
    pub const EXPIRED: &str = "PassExpired";
    pub const WRONG_EPOCH: &str = "PassWrongEpoch";
    pub const REPLAY: &str = "PassReplay";
    pub const PASS_CAP: &str = "PassExceedsAmount";
    pub const PER_BUYER_CAP: &str = "PerBuyerCap";
    pub const NO_REGISTRY: &str = "NoAgentRegistry";
    pub const NOT_IMPLICIT: &str = "AgentNotImplicitAccount";
    pub const REGISTRY_FAILED: &str = "AgentRegistryUnreachable";
    pub const AGENT_NOT_REGISTERED: &str = "AgentNotRegistered";
    pub const AGENT_INVALID: &str = "AgentNotValid";
    pub const TICKET_DEPOSIT: &str = "AttachTicketDeposit";
    pub const NEED_DEPOSIT: &str = "RequiresAttachedDeposit";
    pub const STORAGE: &str = "AttachStorageDeposit";
    pub const BAD_MEMORY: &str = "BadMemoryText";
    pub const NO_MEMORY: &str = "UnknownMemory";
    pub const ADOPTED: &str = "MemoryAlreadyAdopted";
    pub const NOT_YET: &str = "NotEnoughConviction";
    pub const NO_BACKING: &str = "NothingBacked";
    pub const THINKER_ONLY: &str = "ThinkerOnly";
    pub const BAD_THOUGHT: &str = "BadThought";
    pub const BAD_SIGNATURE: &str = "ThoughtSignatureInvalid";
    pub const DUP_THOUGHT: &str = "ThoughtAlreadyRecorded";
    pub const SELF_TRANSFER: &str = "CantSendToContract";
    pub const BAD_NAME: &str = "BadName";
    pub const BAD_ICON: &str = "BadIcon";
}

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

/// A pass signer, pinned at init. The evidence hash is published so anyone
/// can check the attestation bundle off-chain; the contract does not parse it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VerifierKey {
    /// Ed25519 public key, 64 lowercase hex chars.
    pub pubkey_hex: String,
    pub name: String,
    pub evidence_hash_hex: String,
}

/// Gated epoch `i` runs from the previous epoch's end (or `starts_at_ms`) to
/// `ends_at_ms`. Caps are whole tokens per buyer for the epoch.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GatedEpoch {
    pub ends_at_ms: u64,
    pub per_buyer_max_tokens: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LaunchConfig {
    pub sale_id: String,
    /// No buys at all before this.
    pub starts_at_ms: u64,
    pub gated_epochs: Vec<GatedEpoch>,
    /// Statically pinned pass signers (dev / simulated gate). May be empty
    /// when `agent_registry` is set.
    pub verifiers: Vec<VerifierKey>,
    /// Shade Agent contract. A pass signed by agent `X` (an implicit account:
    /// X = hex of its Ed25519 key) is accepted only while that contract says
    /// `get_agent(X).validity == "Valid"` — i.e. X registered with a verified
    /// TEE attestation of approved code that hasn't expired.
    pub agent_registry: Option<AccountId>,
}

/// The fields The Pit reads from the Shade agent contract's `get_agent` view
/// (`Option<AgentView>`); everything else in the view is ignored.
#[derive(Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentCheck {
    pub account_id: AccountId,
    pub validity: AgentValidity,
}

/// `"Valid"` → Valid; anything else (e.g. `{"Invalid": [reasons]}`) → Invalid.
/// Hand-written so the contract doesn't need serde_json's dynamic `Value`.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentValidity {
    Valid,
    Invalid,
}

impl<'de> Deserialize<'de> for AgentValidity {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> de::Visitor<'de> for V {
            type Value = AgentValidity;
            fn expecting(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
                f.write_str("agent validity")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<AgentValidity, E> {
                Ok(if v == "Valid" { AgentValidity::Valid } else { AgentValidity::Invalid })
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut m: A) -> Result<AgentValidity, A::Error> {
                while m.next_entry::<de::IgnoredAny, de::IgnoredAny>()?.is_some() {}
                Ok(AgentValidity::Invalid)
            }
        }
        d.deserialize_any(V)
    }
}

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait AgentRegistry {
    fn get_agent(&self, account_id: AccountId) -> Option<AgentCheck>;
}

/// The signed pass (same JSON as tee-gate / $HUMAN). The verifier signs these
/// exact bytes and the buyer submits exactly those bytes.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PassToken {
    pub v: u32,
    pub sale: String,
    pub kind: String,
    pub buyer: AccountId,
    pub epoch: u32,
    /// Max whole tokens this pass may buy (string keeps u128 exact).
    pub max_amount: String,
    /// One-use, ≥ 32 chars.
    pub nonce: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    NotStarted,
    Gated(u32),
    Open,
}

/// Launchpad creator cut: `share_bps` of every harvest goes to `account_id`,
/// the rest to the brain. Fixed at init.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CreatorCut {
    pub account_id: AccountId,
    pub share_bps: u16,
}

/// A memory holders proposed for the brain. Conviction is token-time:
/// Σ amount × (now − since) over its backings, kept as two running sums.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Memory {
    pub id: u64,
    pub text: String,
    pub author: AccountId,
    pub created_ms: u64,
    /// Tokens currently locked behind it.
    pub backed: U128,
    /// Σ amount × since_ms (for conviction).
    pub backed_since_sum: U128,
    /// Set when it joins the canon.
    pub adopted_ms: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Backing {
    pub amount: U128,
    pub since_ms: u64,
    /// Storage deposit, returned when the backing is withdrawn.
    pub deposit: U128,
}

/// What the brain submits for each thought. NEAR AI Cloud signs
/// `"<request_hash>:<response_hash>"` (gateway) or
/// `"<model>:<request_hash>:<response_hash>"` (provider_tee) with an Ed25519 key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ThoughtInput {
    pub text: String,
    pub model: String,
    pub chat_id: String,
    /// "gateway" or "provider_tee".
    pub signature_kind: String,
    pub request_hash: String,
    pub response_hash: String,
    pub signature_hex: String,
    pub signing_address: String,
    /// sha256 of the TEE attestation report fetched before the completion.
    pub attestation_hash: Option<String>,
}

/// A Proof-of-Thought record: the signature was verified on-chain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Thought {
    pub id: u64,
    pub text: String,
    pub model: String,
    pub chat_id: String,
    pub signature_kind: String,
    pub request_hash: String,
    pub response_hash: String,
    pub signature_hex: String,
    pub signing_address: String,
    pub attestation_hash: Option<String>,
    /// The canon this thought was shown.
    pub canon_hash: String,
    pub tier: String,
    pub recorded_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MemoryView {
    pub memory: Memory,
    /// Token-time accumulated so far, and what adoption needs.
    pub conviction: U128,
    pub threshold: U128,
}

/// Evolution tier: unlocked once principal reaches `min_principal` yocto.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tier {
    pub name: String,
    pub min_principal: U128,
}

/// Our cached view of one validator pool. Refreshed on every `rebalance`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PoolState {
    pub account_id: AccountId,
    pub staked: U128,
    pub unstaked: U128,
    pub can_withdraw: bool,
    pub synced_ms: u64,
}

/// A sell that couldn't be paid from the liquid buffer. Price is fixed at sell
/// time; active claims are visited with bounded round-robin traversal.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Ticket {
    pub id: u64,
    pub account_id: AccountId,
    pub amount: U128,
    /// Seller-funded storage deposit, returned with the payout.
    pub deposit: U128,
    pub created_ms: u64,
    /// Locked until the transfer callback resolves; never unlocked by timeout.
    pub in_flight: bool,
    pub receiver_id: AccountId,
    pub failed: bool,
}

/// Persistent caller-funded credit. Storage remains registered between refunds.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RefundCredit {
    pub storage_paid: U128,
    pub available: U128,
    pub in_flight: U128,
    pub receiver_id: AccountId,
    pub failed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct HarvestClaim {
    pub account_id: AccountId,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub in_flight: bool,
    pub failed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SellResult {
    /// "paying" (awaiting confirmation) or "queued".
    pub status: String,
    pub near_out: U128,
    pub ticket_id: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LaunchInfo {
    /// "not_started" | "gated" | "open"
    pub phase: String,
    pub epoch: Option<u32>,
    pub now_ms: u64,
    pub launch: Option<LaunchConfig>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BrainStats {
    pub brain: AccountId,
    pub principal: U128,
    pub liquid: U128,
    pub staked: U128,
    pub unstaking: U128,
    pub surplus: U128,
    pub target_liquid: U128,
    pub queue_owed: U128,
    pub queue_len: u64,
    /// Harvested NEAR that went to the brain (its food).
    pub total_harvested: U128,
    pub creator: Option<CreatorCut>,
    /// Harvested NEAR that went to the creator.
    pub creator_earned: U128,
    pub total_fees: U128,
    pub total_supply: U128,
    pub spot_price: U128,
    pub fee_bps: u16,
    pub buffer_bps: u16,
    pub tier_index: u32,
    pub tier: Tier,
    pub next_tier: Option<Tier>,
    pub pool_op_in_flight: bool,
    pub phase: String,
}

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

fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

/// Standard base64 (with padding) → 64-byte signature.
fn decode_sig(sig_b64: &str) -> [u8; 64] {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let b = sig_b64.as_bytes();
    // 64 bytes encode to 88 chars ending in "==".
    let ok = b.len() == 88 && b[86] == b'=' && b[87] == b'=';
    let mut out = [0u8; 64];
    let mut n = 0;
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in &b[..if ok { 86 } else { 0 }] {
        let Some(v) = val(c) else { env::panic_str(err::BAD_PASS) };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if n == 64 {
                env::panic_str(err::BAD_PASS);
            }
            out[n] = (acc >> bits) as u8;
            n += 1;
        }
    }
    if n != 64 {
        env::panic_str(err::BAD_PASS);
    }
    out
}

fn decode_key(hex_key: &str) -> Option<[u8; 32]> {
    hex::decode(hex_key).ok()?.try_into().ok()
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// Did the single callback input succeed? Reads no data: a successful call
/// that returns a value reports `TooLong`, which is still a success.
fn promise_ok() -> bool {
    env::promise_results_count() == 1
        && !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

/// NEP-297 event. `data` is one JSON object; every string interpolated into
/// it is an account id, a decimal number or a fixed label, so needs no escaping.
fn event(kind: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"pit","version":"1.0.0","event":"{kind}","data":[{data}]}}"#
    ));
}

/// Names: 1–64 chars, no control or invisible/bidi formatting characters
/// (which could make one coin look like another).
pub fn valid_name(s: &str) -> bool {
    let n = s.chars().count();
    (1..=64).contains(&n)
        && s.trim() == s
        && !s.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}')
        })
}

/// Icons: a short emoji/text, or a base64 raster data URL (no SVG: it can carry script).
pub fn valid_icon(s: &str) -> bool {
    if s.len() > MAX_ICON_BYTES {
        return false;
    }
    for prefix in ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"] {
        if let Some(b64) = s.strip_prefix(prefix) {
            return !b64.is_empty() && b64.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c));
        }
    }
    s.len() <= 32 && !s.contains(':') && !s.contains('<') && valid_name(s)
}

/// Verifier names land in event JSON, so keep them to safe characters.
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
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

    // ————— trading —————

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

    // ————— keeper methods (permissionless) —————

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

    // ————— the mind: holder-owned memory —————

    /// Propose a memory for the brain (≤ 280 bytes). Attach enough NEAR for
    /// its storage; any excess comes back. Returns the memory id.
    #[payable]
    pub fn propose_memory(&mut self, text: String) -> u64 {
        let text = text.trim().to_string();
        require!(
            !text.is_empty() && text.len() <= MAX_MEMORY_BYTES && !text.chars().any(char::is_control),
            err::BAD_MEMORY
        );
        let author = env::predecessor_account_id();
        let id = self.memory_count;
        let before = env::storage_usage();
        self.memories.insert(
            &id,
            &Memory { id, text, author: author.clone(), created_ms: now_ms(), backed: U128(0), backed_since_sum: U128(0), adopted_ms: None },
        );
        self.memory_count += 1;
        self.charge_storage(before, &author);
        event("memory_proposed", &format!(r#"{{"id":{id},"author":"{author}"}}"#));
        id
    }

    /// Lock `amount` tokens behind a memory. Conviction grows the longer they
    /// stay; withdraw any time with `unback_memory`. First backing of a memory
    /// needs a small storage deposit, returned on withdrawal.
    #[payable]
    pub fn back_memory(&mut self, id: u64, amount: U128) {
        require!(amount.0 > 0, err::ZERO);
        let mut m = self.memories.get(&id).unwrap_or_else(|| env::panic_str(err::NO_MEMORY));
        require!(m.adopted_ms.is_none(), err::ADOPTED);
        let who = env::predecessor_account_id();
        let key = format!("{id}|{who}");
        let now = now_ms();

        let before = env::storage_usage();
        let mut b = self.backings.get(&key).unwrap_or(Backing { amount: U128(0), since_ms: now, deposit: U128(0) });
        // Topping up: the new tokens start accruing now.
        let total = b.amount.0 + amount.0;
        let since = (b.amount.0 * u128::from(b.since_ms) + amount.0 * u128::from(now)) / total;
        b.amount = U128(total);
        b.since_ms = since as u64;
        self.ft.internal_transfer(&who, &env::current_account_id(), amount.0, Some("back memory".into()));
        m.backed = U128(m.backed.0 + amount.0);
        m.backed_since_sum = U128(m.backed_since_sum.0 + amount.0 * u128::from(now));
        self.memories.insert(&id, &m);
        self.backings.insert(&key, &b);
        let paid = self.charge_storage(before, &who);
        if paid > 0 {
            b.deposit = U128(b.deposit.0 + paid);
            self.backings.insert(&key, &b);
        }
        event("memory_backed", &format!(r#"{{"id":{id},"account_id":"{who}","amount":"{}"}}"#, amount.0));
    }

    /// Withdraw your tokens (and storage deposit) from a memory — before or
    /// after it's adopted. Adopted memories stay in the canon.
    pub fn unback_memory(&mut self, id: u64) -> U128 {
        let who = env::predecessor_account_id();
        let key = format!("{id}|{who}");
        let b = self.backings.get(&key).unwrap_or_else(|| env::panic_str(err::NO_BACKING));
        let mut m = self.memories.get(&id).unwrap_or_else(|| env::panic_str(err::NO_MEMORY));
        if m.adopted_ms.is_none() {
            m.backed = U128(m.backed.0 - b.amount.0);
            m.backed_since_sum = U128(m.backed_since_sum.0 - b.amount.0 * u128::from(b.since_ms));
            self.memories.insert(&id, &m);
        }
        self.backings.remove(&key);
        self.ft.internal_transfer(&env::current_account_id(), &who, b.amount.0, Some("unback memory".into()));
        if b.deposit.0 > 0 {
            self.credit_refund(&who, b.deposit.0);
        }
        event("memory_unbacked", &format!(r#"{{"id":{id},"account_id":"{who}","amount":"{}"}}"#, b.amount.0));
        b.amount
    }

    /// Anyone can adopt a memory once its conviction reaches the threshold.
    pub fn adopt_memory(&mut self, id: u64) {
        let mut m = self.memories.get(&id).unwrap_or_else(|| env::panic_str(err::NO_MEMORY));
        require!(m.adopted_ms.is_none(), err::ADOPTED);
        require!(self.conviction_of(&m) >= self.adopt_threshold(), err::NOT_YET);
        m.adopted_ms = Some(now_ms());
        self.memories.insert(&id, &m);
        if self.canon.len() == MAX_CANON {
            self.canon.remove(0);
        }
        self.canon.push(id);
        let mut link = self.canon_hash.to_vec();
        link.extend_from_slice(&id.to_le_bytes());
        link.extend_from_slice(&env::sha256(m.text.as_bytes()));
        self.canon_hash = env::sha256_array(&link);
        event("memory_adopted", &format!(r#"{{"id":{id},"canon_hash":"{}"}}"#, hex::encode(self.canon_hash)));
    }

    // ————— the mind: Proof of Thought —————

    /// Record a thought with its NEAR AI Cloud signature. Only the thinker.
    /// The contract checks the signed text has exactly the documented shape
    /// and that the Ed25519 signature is valid. Attach storage (excess back).
    #[payable]
    pub fn record_thought(&mut self, #[serializer(borsh)] thought: ThoughtInput) -> u64 {
        let who = env::predecessor_account_id();
        require!(self.thinker.as_ref() == Some(&who), err::THINKER_ONLY);
        let t = thought;
        let hex64 = |s: &str| s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        require!(
            !t.text.trim().is_empty()
                && t.text.len() <= MAX_THOUGHT_BYTES
                && t.model.len() <= 128
                && t.chat_id.len() <= 128
                && hex64(&t.request_hash)
                && hex64(&t.response_hash)
                && t.attestation_hash.as_deref().is_none_or(hex64),
            err::BAD_THOUGHT
        );
        let signed = match t.signature_kind.as_str() {
            "gateway" => format!("{}:{}", t.request_hash, t.response_hash),
            "provider_tee" => format!("{}:{}:{}", t.model, t.request_hash, t.response_hash),
            _ => env::panic_str(err::BAD_THOUGHT),
        };
        let key = decode_key(&t.signing_address).unwrap_or_else(|| env::panic_str(err::BAD_SIGNATURE));
        let sig: [u8; 64] = hex::decode(&t.signature_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str(err::BAD_SIGNATURE));
        require!(env::ed25519_verify(&sig, signed.as_bytes(), &key), err::BAD_SIGNATURE);

        let id = self.thought_count;
        let before = env::storage_usage();
        let response = hex::decode(&t.response_hash).unwrap_or_else(|_| env::panic_str(err::BAD_THOUGHT));
        require!(self.recorded_responses.insert(&response), err::DUP_THOUGHT);
        let tier = self.tiers[self.tier_index()].name.clone();
        self.thoughts.insert(
            &(id % THOUGHT_SLOTS),
            &Thought {
                id,
                text: t.text,
                model: t.model,
                chat_id: t.chat_id,
                signature_kind: t.signature_kind,
                request_hash: t.request_hash,
                response_hash: t.response_hash.clone(),
                signature_hex: t.signature_hex,
                signing_address: t.signing_address.clone(),
                attestation_hash: t.attestation_hash,
                canon_hash: hex::encode(self.canon_hash),
                tier,
                recorded_ms: now_ms(),
            },
        );
        self.thought_count += 1;
        self.charge_storage(before, &who);
        event(
            "thought",
            &format!(r#"{{"id":{id},"signing_address":"{}","response_hash":"{}"}}"#, t.signing_address, t.response_hash),
        );
        id
    }

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

    // ————— views —————

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

    // ————— internal —————

    /// Bill the caller for storage this call added; refund the rest of the
    /// deposit. Returns what was kept.
    fn charge_storage(&mut self, before: u64, payer: &AccountId) -> u128 {
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
    fn ensure_refund_credit(&mut self, owner: &AccountId) -> u128 {
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

    fn credit_refund(&mut self, owner: &AccountId, amount: u128) {
        if amount == 0 { return; }
        let mut credit = self.refund_credits.get(owner).expect("RefundAccountNotRegistered");
        credit.available = U128(credit.available.0 + amount);
        self.refund_credits.insert(owner, &credit);
    }

    fn adopt_threshold(&self) -> u128 {
        // Supply × ADOPT_BPS held for ADOPT_WINDOW_MS, in token·ms, with a floor.
        (self.ft.total_supply * ADOPT_BPS / BPS).max(MIN_ADOPT_TOKENS) * ADOPT_WINDOW_MS
    }

    fn conviction_of(&self, m: &Memory) -> u128 {
        (m.backed.0 * u128::from(now_ms())).saturating_sub(m.backed_since_sum.0)
    }

    fn memory_view(&self, m: Memory) -> MemoryView {
        MemoryView { conviction: U128(self.conviction_of(&m)), threshold: U128(self.adopt_threshold()), memory: m }
    }

    /// Everything a pass binds, except who signed it. Returns the pass's token
    /// cap (atoms) and its nullifier. Doesn't change state.
    fn check_pass(&self, pass: &str, buyer: &AccountId, epoch: u32) -> Result<(u128, Vec<u8>), &'static str> {
        let launch = self.launch.as_ref().ok_or(err::NOT_GATED)?;
        let p: PassToken = near_sdk::serde_json::from_str(pass).map_err(|_| err::BAD_PASS)?;
        if !(p.v == 1 && p.kind == "human" && p.nonce.len() >= 32) {
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
    fn settle_gated(
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
    fn try_settle_buy(
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

    fn phase_label(&self) -> (&'static str, Option<u32>) {
        match self.phase() {
            Phase::NotStarted => ("not_started", None),
            Phase::Gated(i) => ("gated", Some(i)),
            Phase::Open => ("open", None),
        }
    }

    fn phase(&self) -> Phase {
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

    fn fee_of(&self, x: u128) -> u128 {
        x * u128::from(self.fee_bps) / BPS
    }

    fn near_reserve(&self) -> u128 {
        self.virtual_near + self.principal
    }

    fn token_reserve(&self) -> u128 {
        self.virtual_tokens - self.ft.total_supply
    }

    fn quote_buy_net(&self, net: u128) -> u128 {
        mul_div(self.token_reserve(), net, self.near_reserve() + net)
    }

    fn quote_sell_gross(&self, amount: u128) -> u128 {
        mul_div(self.near_reserve(), amount, self.token_reserve() + amount)
    }

    /// Assets above what's owed to holders and queued sellers.
    fn surplus(&self) -> u128 {
        let pooled: u128 = self.pools.iter().map(|p| p.staked.0 + p.unstaked.0).sum();
        (self.liquid + pooled).saturating_sub(self.principal + self.queue_owed + SURPLUS_MARGIN)
    }

    /// Liquid NEAR we want on hand: the sell buffer, queued payouts, and the
    /// surplus (so it can be harvested).
    fn target_liquid(&self) -> u128 {
        self.buffer() + self.queue_owed + self.surplus()
    }

    fn buffer(&self) -> u128 {
        self.principal * u128::from(self.buffer_bps) / BPS
    }

    fn tier_index(&self) -> usize {
        self.tiers
            .iter()
            .rposition(|t| self.principal >= t.min_principal.0)
            .unwrap_or(0)
    }
}

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
