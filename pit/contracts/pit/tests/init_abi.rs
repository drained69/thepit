//! `new` takes Borsh args. This fixture was produced by `coinInitBorsh` in
//! pit/scripts/deploy.mjs; decoding it here proves the deploy script and the
//! contract agree on the byte layout. (The factory's encoder is covered by the
//! launchpad sandbox test.)

#![cfg(feature = "unit-tests")]

use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::U128;
use near_sdk::AccountId;
use pit::{CreatorCut, LaunchConfig, Tier};

#[derive(BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
#[allow(dead_code)]
struct Init {
    brain: AccountId,
    pools: Vec<AccountId>,
    virtual_near: U128,
    virtual_tokens: U128,
    fee_bps: u16,
    buffer_bps: u16,
    tiers: Vec<Tier>,
    name: String,
    symbol: String,
    icon: Option<String>,
    launch: Option<LaunchConfig>,
    creator: Option<CreatorCut>,
    thinker: Option<AccountId>,
}

const FROM_DEPLOY_SCRIPT: &str = "0a000000627261696e2e6e656172020000000d000000612e706f6f6c76312e6e6561720d000000622e706f6f6c76312e6e656172000000b8b68071dfb58ab10900000000000000d1ffefc88d96907703000000006400d00702000000050000004c6172766100000000000000000000000000000000050000004164756c74000000106102253e5ece4f20000000000f0000005468652050697420f09f95b3efb88f030000005049540001070000005049542d303031695e3cafa101000001000000e94c73afa101000080841e0000000000000000000000000001000000400000006162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616206000000676174652d314000000030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030010b0000006167656e74732e6e65617201070000006d652e6e656172c409010e0000006b65657065722e6d652e6e656172";

#[test]
fn deploy_script_encodes_init_args_the_contract_reads() {
    let bytes = hex::decode(FROM_DEPLOY_SCRIPT).unwrap();
    let a = Init::try_from_slice(&bytes).expect("exact layout, no trailing bytes");
    assert_eq!(a.brain.as_str(), "brain.near");
    assert_eq!(a.pools.len(), 2);
    assert_eq!(a.virtual_near.0, 3_000 * 10u128.pow(24));
    assert_eq!(a.virtual_tokens.0, 1_073_000_000 * 10u128.pow(18));
    assert_eq!((a.fee_bps, a.buffer_bps), (100, 2_000));
    assert_eq!(a.tiers[1].name, "Adult");
    assert_eq!(a.tiers[1].min_principal.0, 10_000 * 10u128.pow(24));
    assert_eq!(a.name, "The Pit 🕳️");
    assert_eq!(a.icon, None);
    let l = a.launch.unwrap();
    assert_eq!(l.sale_id, "PIT-001");
    assert_eq!(l.starts_at_ms, 1_793_941_331_561);
    assert_eq!(l.gated_epochs[0].per_buyer_max_tokens.0, 2_000_000);
    assert_eq!(l.verifiers[0].name, "gate-1");
    assert_eq!(l.agent_registry.unwrap().as_str(), "agents.near");
    let c = a.creator.unwrap();
    assert_eq!((c.account_id.as_str(), c.share_bps), ("me.near", 2_500));
    assert_eq!(a.thinker.unwrap().as_str(), "keeper.me.near");
}
