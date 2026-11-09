//! Public data types: launch configuration, claims, memories, thoughts and view structs.

use crate::*;

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

