/*
 * $HUMAN — pass-gated token launch prototype on NEAR.
 *
 * Spec: docs/02-mechanics.md (frozen v1).
 *
 * Pass-gated phase checks: registered-key Ed25519 signature, account/sale/
 * epoch/expiry/cap binding, exact payment, wallet caps, and one-use pass hash.
 * Verifier registration is an owner trust decision; the contract stores an
 * evidence hash but does not validate attestation. After pass-gated epochs,
 * the configured open phase allows public purchases at a worse price.
 */

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    events::FtMint, FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, LookupSet, Vector};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use sha2::{Digest, Sha256};

/// FT base units: 10^24 atoms per whole $HUMAN token.
pub const ATOMS_PER_TOKEN: u128 = 1_000_000_000_000_000_000_000_000;

/// Error labels surfaced by the contract — the webapp matches on them.
mod err {
    pub const UNKNOWN_VERIFIER: &str = "PassUnknownVerifier";
    pub const NOT_FOR_YOU: &str = "PassNotForYou";
    pub const REPLAY: &str = "PassReplay";
    pub const EXPIRED: &str = "PassExpired";
    pub const WRONG_SALE: &str = "PassWrongSale";
    pub const TOO_MUCH: &str = "PassExceedsAmount";
    pub const BAD_PASS_JSON: &str = "PassMalformed";
    pub const WRONG_EPOCH: &str = "EpochClosedOrFuture";
    pub const PER_BUYER_CAP: &str = "PerBuyerCap";
    pub const WRONG_DEPOSIT: &str = "WrongAttachedDeposit";
    pub const PAUSED: &str = "SalePaused";
    pub const NO_SUPPLY: &str = "NotEnoughSupply";
    pub const FT_NOT_REGISTERED: &str = "IncludeStorageDeposit";
}

/// A human-only epoch. Config is immutable after init (see threat model A12).
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct EpochConfig {
    /// Inclusive start, milliseconds since epoch (UTC).
    pub starts_at_ms: u64,
    /// Exclusive end.
    pub ends_at_ms: u64,
    /// Sale price: yoctoNEAR per WHOLE token.
    pub price_yocto_per_token: u128,
    /// Hard cap per buyer in this epoch.
    pub per_buyer_max_tokens: u128,
    /// Total allocation of this epoch; unsold rolls into the next phase.
    pub epoch_cap_tokens: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Debug)]
pub struct EpochSold {
    pub sold_atoms: u128,
    pub buyers: u64,
}

/// Open-phase config: strictly after every human epoch, strictly worse price.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct OpenConfig {
    pub ends_at_ms: u64,
    pub price_yocto_per_token: u128,
    pub per_buyer_max_tokens: u128,
    pub open_cap_tokens: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Verifier {
    /// Ed25519 public key, 64 lowercase hex chars.
    pub pubkey_hex: String,
    /// Operator label, e.g. "near-ai-cloud/model-slug" or "human-gate-nitro-1".
    pub name: String,
    /// sha256 hex of the evidence bundle approving this key.
    pub evidence_hash_hex: String,
    pub approved: bool,
    pub added_at_ms: u64,
}

/// The TEE-signed pass. The verifier signs these exact JSON bytes; the on-chain
/// call submits exactly those bytes (no canonicalization anywhere).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PassToken {
    pub v: u32,
    pub sale: String,
    /// "human" in v1; the registry is kind-aware for future checker tiers.
    pub kind: String,
    pub buyer: AccountId,
    pub epoch: u32,
    /// Max tokens this pass allows (string to keep u128 exact).
    pub max_amount: String,
    /// 64 hex chars, one-shot.
    pub nonce: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    NotStarted,
    Human(u32),
    Open,
    Finalized,
}

impl Phase {
    pub fn label(&self) -> &'static str {
        match self {
            Phase::NotStarted => "pre",
            Phase::Human(_) => "human",
            Phase::Open => "open",
            Phase::Finalized => "finalized",
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HumanSaleContract {
    /// NEP-141 core; `total_supply` is tracked inside (stdlib).
    ft: FungibleToken,

    owner: AccountId,
    sale_id: String,
    paused: bool,
    finalized: bool,

    epochs: Vec<EpochConfig>,
    epoch_sold: Vector<EpochSold>,
    /// Per-epoch allocation cap + per-buyer cap, pre-converted to atoms.
    epoch_cap_atoms: Vector<u128>,
    per_buyer_atoms: Vector<u128>,
    open_cfg: OpenConfig,
    /// Open-phase allocation cap + per-buyer cap in atoms.
    open_cap_atoms: u128,
    open_per_buyer_atoms: u128,
    open_sold: u128,

    sale_supply: u128,
    sold_total: u128,
    /// Fixed at init: sale + treasury. `ft.total_supply` tracks minted-only.
    total_supply_cap: u128,

    /// sha256(pass bytes) hex set. One pass = one purchase, ever.
    used_pass: LookupSet<String>,
    /// "acct|phase" → tokens bought in that phase (human epochs + "open").
    buyer_phase_bought: LookupMap<String, u128>,
    /// acct → lifetime tokens bought through gated purchases.
    buyer_human_total: LookupMap<AccountId, u128>,

    /// Registered verifiers. The owner proves evidence off-chain; the chain
    /// pins pubkey + evidence_hash. Anyone can re-verify the bundle locally.
    verifier_keys: Vector<String>,
    verifiers: LookupMap<String, Verifier>,

    /// NEP-148 metadata, fixed at deploy.
    metadata: FungibleTokenMetadata,
}

#[near]
impl HumanSaleContract {
    #[init]
    #[payable]
    pub fn new(
        owner: AccountId,
        sale_id: String,
        epochs: Vec<EpochConfig>,
        open_cfg: OpenConfig,
        total_supply: U128,
        treasury_percent: u16,
        token_name: String,
        token_symbol: String,
        token_decimals: u8,
        token_icon: Option<String>,
        metadata_reference: Option<String>,
    ) -> Self {
        require!(
            treasury_percent > 0 && treasury_percent < 100,
            "treasury_percent is 1..=99 (sale gets the rest)"
        );
        require!(!epochs.is_empty() && epochs.len() <= 8, "1..=8 human epochs");
        for w in epochs.windows(2) {
            require!(
                w[0].ends_at_ms == w[1].starts_at_ms,
                "epochs must be contiguous and ordered"
            );
        }
        let now = env::block_timestamp_ms();
        require!(epochs[0].starts_at_ms > now, "epochs must start in the future");
        require!(
            open_cfg.ends_at_ms > epochs.last().unwrap().ends_at_ms,
            "open phase must end after the last epoch"
        );
        require!(open_cfg.price_yocto_per_token > 0, "price > 0");
        require!(open_cfg.open_cap_tokens > 0, "open cap > 0");
        for e in &epochs {
            require!(e.ends_at_ms > e.starts_at_ms, "epoch end > start");
            require!(e.price_yocto_per_token > 0, "price > 0");
            require!(e.epoch_cap_tokens > 0, "epoch cap > 0");
            require!(e.per_buyer_max_tokens > 0, "per buyer cap > 0");
            // Public-phase price is strictly worse than every priority epoch price.
            require!(
                open_cfg.price_yocto_per_token > e.price_yocto_per_token,
                "public price must exceed every priority epoch price"
            );
        }

        let supply = total_supply.0;
        require!(supply > 0, "supply > 0");
        let sale_supply = supply / 100 * u128::from(100u16 - treasury_percent);
        require!(sale_supply > 0, "sale supply is empty");
        // Allocation caps from the deploy script are in whole tokens; convert
        // to FT atoms once, here, so the hot paths never re-multiply.
        let open_cap_tokens = open_cfg.open_cap_tokens;
        let open_per_buyer_tokens = open_cfg.per_buyer_max_tokens;
        let mut total_sale_cap_atoms = open_cap_tokens
            .checked_mul(ATOMS_PER_TOKEN)
            .expect("open cap atoms overflow");
        for e in &epochs {
            total_sale_cap_atoms = total_sale_cap_atoms
                .checked_add(
                    e.epoch_cap_tokens
                        .checked_mul(ATOMS_PER_TOKEN)
                        .expect("cap atoms overflow"),
                )
                .expect("total sale cap overflow");
        }
        require!(
            total_sale_cap_atoms <= sale_supply,
            "epoch caps + open cap exceed sale supply"
        );

        let mut this = Self {
            ft: FungibleToken::new(b"ft".to_vec()),
            owner: owner.clone(),
            sale_id,
            paused: false,
            finalized: false,
            epochs: epochs.clone(),
            epoch_sold: Vector::new(b"epoch_sold".to_vec()),
            epoch_cap_atoms: Vector::new(b"epoch_cap_atoms".to_vec()),
            per_buyer_atoms: Vector::new(b"per_buyer_atoms".to_vec()),
            open_cfg,
            open_cap_atoms: 0,
            open_per_buyer_atoms: 0,
            open_sold: 0,
            sale_supply,
            sold_total: 0,
            total_supply_cap: total_supply.0,
            used_pass: LookupSet::new(b"used_pass".to_vec()),
            buyer_phase_bought: LookupMap::new(b"buyer_phase_bought".to_vec()),
            buyer_human_total: LookupMap::new(b"buyer_human_total".to_vec()),
            verifier_keys: Vector::new(b"verifier_keys".to_vec()),
            verifiers: LookupMap::new(b"verifiers".to_vec()),
            metadata: FungibleTokenMetadata {
                spec: "ft-1.0.0".to_string(),
                name: token_name,
                symbol: token_symbol,
                icon: token_icon,
                reference: metadata_reference,
                reference_hash: None,
                decimals: token_decimals,
            },
        };

        // Pre-mint the transparent treasury; the sale mints its slice only on
        // purchases. Tokens still unsold after the public phase are never minted.
        let treasury = supply - this.sale_supply;
        this.ft.internal_register_account(&owner);
        this.ft.internal_deposit(&owner, treasury);
        FtMint {
            owner_id: &owner,
            amount: U128(treasury),
            memo: Some("treasury pre-mint"),
        }
        .emit();

        for e in epochs.iter() {
            this.epoch_sold.push(&EpochSold {
                sold_atoms: 0,
                buyers: 0,
            });
            this.epoch_cap_atoms.push(
                &e.epoch_cap_tokens
                    .checked_mul(ATOMS_PER_TOKEN)
                    .expect("cap atoms overflow"),
            );
            this.per_buyer_atoms.push(
                &e.per_buyer_max_tokens
                    .checked_mul(ATOMS_PER_TOKEN)
                    .expect("per-buyer atoms overflow"),
            );
        }
        this.open_cap_atoms = open_cap_tokens
            .checked_mul(ATOMS_PER_TOKEN)
            .expect("open cap atoms overflow");
        this.open_per_buyer_atoms = open_per_buyer_tokens
            .checked_mul(ATOMS_PER_TOKEN)
            .expect("open per-buyer atoms overflow");
        this
    }

    // ————— verifier registry (owner-gated; evidence bundle is the real gate) —————

    pub fn register_verifier(
        &mut self,
        pubkey_hex: String,
        name: String,
        evidence_hash_hex: String,
    ) {
        self.assert_owner();
        let key = pubkey_hex.to_ascii_lowercase();
        require!(key.len() == 64, "pubkey must be 64 hex chars (ed25519)");
        require!(hex::decode(&key).is_ok(), "pubkey must be valid hex");
        require!(
            hex::decode(&evidence_hash_hex)
                .map(|v| v.len() == 32)
                .unwrap_or(false),
            "evidence hash must be 32 hex bytes (sha256)"
        );
        require!(!name.is_empty(), "verifier needs a name");
        require!(
            !self.verifiers.contains_key(&key),
            "VerifierAlreadyRegistered"
        );
        require!(self.verifier_keys.len() < 8, "VerifierLimit");
        self.verifier_keys.push(&key);
        let verifier = Verifier {
            pubkey_hex: key.clone(),
            name,
            evidence_hash_hex,
            approved: true,
            added_at_ms: env::block_timestamp_ms(),
        };
        self.verifiers.insert(&key, &verifier);
    }

    pub fn revoke_verifier(&mut self, pubkey_hex: String) {
        self.assert_owner();
        let key = pubkey_hex.to_ascii_lowercase();
        let mut v = self
            .verifiers
            .get(&key)
            .unwrap_or_else(|| env::panic_str("VerifierUnknown"));
        v.approved = false;
        self.verifiers.insert(&key, &v);
    }

    // ————— the gate —————

    /// Human-epoch purchase. Requires a pass signed by a registered, approved
    /// verifier; the signature binds buyer, amount cap, epoch, expiry and the
    /// one-shot nonce to the exact bytes submitted. The attached deposit buys
    /// tokens at the epoch price; the whole deposit must be consumed exactly.
    #[payable]
    pub fn purchase(&mut self, pass: String, sig_b64: String) {
        require!(!self.paused, err::PAUSED);
        require!(!self.finalized, "SaleFinalized");
        let buyer = env::predecessor_account_id();

        let sig = BASE64
            .decode(sig_b64.as_bytes())
            .expect("sig_b64 must be valid base64");
        require!(sig.len() == 64, "sig must be exactly 64 bytes");
        let sig: [u8; 64] = sig.try_into().expect("sig length checked");

        // 1. The signature must come from a registered, approved verifier.
        let mut verifier: Option<Verifier> = None;
        for k in self.verifier_keys.iter() {
            let v = self.verifiers.get(&k).expect("verifier_keys consistency");
            if !v.approved {
                continue;
            }
            let key_bytes: [u8; 32] = hex::decode(&v.pubkey_hex)
                .expect("stored keys are hex")
                .try_into()
                .expect("stored keys are 32 bytes");
            if env::ed25519_verify(&sig, pass.as_bytes(), &key_bytes) {
                verifier = Some(v);
                break;
            }
        }
        let verifier = verifier.unwrap_or_else(|| env::panic_str(err::UNKNOWN_VERIFIER));

        // 2. Parse the pass, re-asserting everything the signature binds.
        let parsed: PassToken = serde_json::from_str(&pass)
            .unwrap_or_else(|_| env::panic_str(err::BAD_PASS_JSON));
        require!(parsed.v == 1 && parsed.kind == "human", err::BAD_PASS_JSON);
        require!(parsed.sale == self.sale_id, err::WRONG_SALE);
        require!(parsed.buyer == buyer, err::NOT_FOR_YOU);
        require!(
            parsed.expires_at_ms >= env::block_timestamp_ms(),
            err::EXPIRED
        );
        require!(parsed.nonce.len() >= 32, "nonce too short");

        // 3. Epoch must be the live human epoch.
        match self.phase_at(env::block_timestamp_ms()) {
            Phase::Human(idx) if idx == parsed.epoch => {}
            _ => env::panic_str(err::WRONG_EPOCH),
        }

        // 4. One-shot: hash-replay anchor on the exact signed bytes.
        let pass_hash = hex::encode(Sha256::digest(pass.as_bytes()));
        require!(!self.used_pass.contains(&pass_hash), err::REPLAY);

        // 5. Economics: exact deposit, price math, per-buyer and epoch caps
        //    (all allocation accounting is in token atoms).
        let epoch_cfg = self.epochs[parsed.epoch as usize].clone();
        let deposit = env::attached_deposit().as_yoctonear();
        let amount = deposit / epoch_cfg.price_yocto_per_token;
        require!(amount > 0, err::WRONG_DEPOSIT);
        require!(
            deposit == amount * epoch_cfg.price_yocto_per_token,
            err::WRONG_DEPOSIT
        );
        let atoms = amount
            .checked_mul(ATOMS_PER_TOKEN)
            .expect("token atoms overflow");
        let pass_max_atoms: u128 = parsed
            .max_amount
            .parse::<u128>()
            .unwrap_or(0);
        let pass_max_atoms = pass_max_atoms
            .checked_mul(ATOMS_PER_TOKEN)
            .expect("pass max overflow");
        require!(pass_max_atoms > 0 && atoms <= pass_max_atoms, err::TOO_MUCH);

        let epoch_sold_before = self
            .epoch_sold
            .get(u64::from(parsed.epoch))
            .expect("epoch array initialized");
        let cap_atoms = self
            .epoch_cap_atoms
            .get(u64::from(parsed.epoch))
            .expect("cap array initialized")
            .saturating_sub(epoch_sold_before.sold_atoms);
        let epoch_remaining = cap_atoms;
        require!(atoms <= epoch_remaining, err::NO_SUPPLY);

        let buyer_phase_key = format!("{}|{}", buyer, parsed.epoch);
        let already = self.buyer_phase_bought.get(&buyer_phase_key).unwrap_or(0u128);
        let per_buyer_cap = self
            .per_buyer_atoms
            .get(u64::from(parsed.epoch))
            .expect("per buyer array initialized");
        let buyer_total = already
            .checked_add(atoms)
            .unwrap_or_else(|| env::panic_str(err::PER_BUYER_CAP));
        require!(buyer_total <= per_buyer_cap, err::PER_BUYER_CAP);

        // 6. Explicit NEP-141 registration (webapp runs storage_deposit first).
        require!(self.ft.accounts.contains_key(&buyer), err::FT_NOT_REGISTERED);

        // 7. Settle: mint → advance counters → burn the pass hash (replay closed).
        self.ft.internal_deposit(&buyer, atoms);
        self.epoch_sold.replace(
            u64::from(parsed.epoch),
            &EpochSold {
                sold_atoms: epoch_sold_before.sold_atoms.checked_add(atoms).unwrap(),
                buyers: epoch_sold_before.buyers.saturating_add(1),
            },
        );
        self.buyer_phase_bought
            .insert(&buyer_phase_key, &buyer_total);
        let total_so_far = self.buyer_human_total.get(&buyer).unwrap_or(0);
        self.buyer_human_total
            .insert(&buyer, &(total_so_far.checked_add(atoms).unwrap()));
        self.sold_total = self.sold_total.checked_add(atoms).unwrap();
        self.used_pass.insert(&pass_hash);

        FtMint {
            owner_id: &buyer,
            amount: U128(atoms),
            memo: Some("human-gate purchase"),
        }
        .emit();
        env::log_str(
            &json!({
                "standard": "human-gate",
                "version": "1.0.0",
                "event": "human_purchase",
                "data": {
                    "buyer": buyer.to_string(),
                    "epoch": parsed.epoch,
                    "amount": amount.to_string(),
                    "verifier": verifier.name,
                    "pass_hash": pass_hash,
                }
            })
            .to_string(),
        );
    }

    /// Public phase: anyone may buy without a pass at a strictly higher price.
    #[payable]
    pub fn purchase_open_phase(&mut self) {
        require!(!self.paused, err::PAUSED);
        require!(!self.finalized, "SaleFinalized");
        require!(
            self.phase_at(env::block_timestamp_ms()) == Phase::Open,
            "OpenPhaseNotStartedOrEnded"
        );
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let amount = deposit / self.open_cfg.price_yocto_per_token;
        require!(amount > 0, err::WRONG_DEPOSIT);
        require!(
            deposit == amount * self.open_cfg.price_yocto_per_token,
            err::WRONG_DEPOSIT
        );
        let atoms = amount
            .checked_mul(ATOMS_PER_TOKEN)
            .expect("token atoms overflow");
        let remaining = self.open_cap_atoms - self.open_sold;
        require!(atoms <= remaining, err::NO_SUPPLY);
        let buyer_phase_key = format!("{}|open", buyer);
        let already = self.buyer_phase_bought.get(&buyer_phase_key).unwrap_or(0u128);
        require!(already + atoms <= self.open_per_buyer_atoms, err::PER_BUYER_CAP);
        require!(self.ft.accounts.contains_key(&buyer), err::FT_NOT_REGISTERED);

        self.ft.internal_deposit(&buyer, atoms);
        self.buyer_phase_bought
            .insert(&buyer_phase_key, &(already.checked_add(atoms).unwrap()));
        self.sold_total = self.sold_total.checked_add(atoms).unwrap();
        self.open_sold = self.open_sold.checked_add(atoms).unwrap();

        env::log_str(
            &json!({
                "standard": "human-gate",
                "version": "1.0.0",
                "event": "bot_tax_purchase",
                "data": {
                    "buyer": buyer.to_string(),
                    "amount": atoms.to_string(),
                }
            })
            .to_string(),
        );
    }

    // ————— owner controls & lifecycle —————

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Ends the sale after the open phase. Unsold sale supply stays unminted
    /// (implicit burn).
    pub fn finalize_sale(&mut self) {
        self.assert_owner();
        require!(
            env::block_timestamp_ms() >= self.open_cfg.ends_at_ms,
            "OpenPhaseMustEndFirst"
        );
        self.finalized = true;
        env::log_str(
            &json!({
                "standard": "human-gate",
                "version": "1.0.0",
                "event": "sale_finalized",
                "data": { "sold_total": self.sold_total.to_string() }
            })
            .to_string(),
        );
    }

    /// Withdraw sale proceeds (the NEAR attached in purchases). Owner only,
    /// after finalize. Contract-owned storage staking stays on the contract.
    pub fn withdraw_proceeds(&mut self, to: AccountId) -> Promise {
        self.assert_owner();
        require!(self.finalized, "SaleMustBeFinalizedFirst");
        let storage_cost = u128::from(env::storage_usage())
            * env::storage_byte_cost().as_yoctonear();
        let available = env::account_balance().as_yoctonear().saturating_sub(storage_cost);
        require!(available > 0, "NoProceeds");
        Promise::new(to).transfer(NearToken::from_yoctonear(available))
    }

    // ————— views —————

    pub fn sale_overview(&self) -> Value {
        let now = env::block_timestamp_ms();
        let phase = self.phase_at(now);
        let current_epoch = match &phase {
            Phase::Human(i) => Some(*i),
            _ => None,
        };
        let epochs_view: Vec<Value> = self
            .epochs
            .iter()
            .enumerate()
            .map(|(i, cfg)| {
                let sold = self
                    .epoch_sold
                    .get(u64::try_from(i).unwrap())
                    .unwrap()
                    .sold_atoms;
                json!({
                    "epoch": i,
                    "starts_at_ms": cfg.starts_at_ms,
                    "ends_at_ms": cfg.ends_at_ms,
                    "price_yocto_per_token": cfg.price_yocto_per_token.to_string(),
                    "tokens_per_near": (10u128.pow(24) / cfg.price_yocto_per_token).to_string(),
                    "cap_tokens": cfg.epoch_cap_tokens.to_string(),
                    "sold_tokens": (sold / ATOMS_PER_TOKEN).to_string(),
                    "sold_atoms": sold.to_string(),
                    "per_buyer_max_tokens": cfg.per_buyer_max_tokens.to_string(),
                })
            })
            .collect();
        json!({
            "contract": env::current_account_id().to_string(),
            "owner": self.owner.to_string(),
            "sale_id": self.sale_id,
            "now_ms": now,
            "phase": phase.label(),
            "current_epoch": current_epoch,
            "paused": self.paused,
            "finalized": self.finalized,
            "sale_supply": self.sale_supply.to_string(),
            "sale_supply_atoms": self.sale_supply.to_string(),
            "sold": self.sold_total.to_string(),
            "sold_atoms": self.sold_total.to_string(),
            "unminted_sale_atoms": (self.sale_supply - self.sold_total).to_string(),
            "total_supply": self.total_supply_cap.to_string(),
            "total_supply_atoms": self.total_supply_cap.to_string(),
            "minted_supply": self.ft.total_supply.to_string(),
            "minted_supply_atoms": self.ft.total_supply.to_string(),
            "open": {
                "ends_at_ms": self.open_cfg.ends_at_ms,
                "price_yocto_per_token": self.open_cfg.price_yocto_per_token.to_string(),
                "tokens_per_near": (10u128.pow(24) / self.open_cfg.price_yocto_per_token).to_string(),
                "per_buyer_max_tokens": self.open_cfg.per_buyer_max_tokens.to_string(),
                "cap_tokens": self.open_cfg.open_cap_tokens.to_string(),
                "sold_tokens": (self.open_sold / ATOMS_PER_TOKEN).to_string(),
                "sold_atoms": self.open_sold.to_string(),
            },
            "epochs": epochs_view,
            "verifier_count": self.verifier_keys.len(),
        })
    }

    pub fn buyer_state(&self, account: AccountId) -> Value {
        let mut per_phase: Vec<Value> = Vec::new();
        for (i, _cfg) in self.epochs.iter().enumerate() {
            per_phase.push(json!({
                "phase": "human",
                "epoch": i,
                "bought": self
                    .buyer_phase_bought
                    .get(&format!("{}|{}", account, i))
                    .unwrap_or(0u128)
                    .to_string(),
            }));
        }
        per_phase.push(json!({
            "phase": "open",
            "epoch": null,
            "bought": self
                .buyer_phase_bought
                .get(&format!("{}|open", account))
                .unwrap_or(0u128)
                .to_string(),
        }));
        json!({
            "balance": self.ft.ft_balance_of(account.clone()).0.to_string(),
            "human_bought_total": self.buyer_human_total.get(&account).unwrap_or(0).to_string(),
            "per_phase": per_phase,
        })
    }

    pub fn verifiers_list(&self) -> Vec<Verifier> {
        self.verifier_keys
            .iter()
            .map(|k| self.verifiers.get(&k).expect("verifier_keys consistency"))
            .collect()
    }

    /// Transparency: is this exact pass string already spent?
    pub fn pass_used(&self, pass: String) -> bool {
        let hash = hex::encode(Sha256::digest(pass.as_bytes()));
        self.used_pass.contains(&hash)
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn total_supply(&self) -> U128 {
        U128(self.total_supply_cap)
    }

    // ————— internal helpers —————

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "OwnerOnly");
    }

    fn phase_at(&self, now_ms: u64) -> Phase {
        if now_ms < self.epochs[0].starts_at_ms {
            return Phase::NotStarted;
        }
        for (i, e) in self.epochs.iter().enumerate() {
            if now_ms >= e.starts_at_ms && now_ms < e.ends_at_ms {
                return Phase::Human(u32::try_from(i).unwrap());
            }
        }
        if now_ms < self.open_cfg.ends_at_ms {
            Phase::Open
        } else {
            Phase::Finalized
        }
    }
}

#[near]
impl FungibleTokenCore for HumanSaleContract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
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
impl FungibleTokenResolver for HumanSaleContract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.ft
            .ft_resolve_transfer(sender_id, previous_owner_id, amount)
    }
}

#[near]
impl StorageManagement for HumanSaleContract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.ft.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.ft.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.ft.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.ft.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.ft.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for HumanSaleContract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}
