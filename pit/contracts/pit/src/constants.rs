//! Limits, fees, gas budgets and error labels. All fixed at compile time.

use crate::*;

/// The Pit uses 18 decimals.
pub const DECIMALS: u8 = 18;
pub const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Fees and buffer are basis points of 10_000.
pub(crate) const BPS: u128 = 10_000;
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
pub(crate) const GAS_POOL_VIEW: Gas = Gas::from_tgas(20);
pub(crate) const GAS_POOL_ACTION: Gas = Gas::from_tgas(75);
pub(crate) const GAS_ON_POOL_STATE: Gas = Gas::from_tgas(120);
pub(crate) const GAS_ON_POOL_ACTION: Gas = Gas::from_tgas(15);
pub(crate) const GAS_REGISTRY_VIEW: Gas = Gas::from_tgas(15);
pub(crate) const GAS_ON_AGENT: Gas = Gas::from_tgas(40);

/// Error labels — the agent and web page match on them.
pub(crate) mod err {
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

