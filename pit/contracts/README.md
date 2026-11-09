# Contracts

Rust smart contracts for NEAR (near-sdk 5.30, built with `cargo-near`, Rust
1.97.1 pinned in `rust-toolchain.toml`).

| Crate | Path | Role | Deployed as |
|---|---|---|---|
| `pit` | [`pit/`](pit/) | The coin: NEP-141 token, bonding curve, staked reserve, payouts, launch gate, mind | One **global contract**, shared by every coin |
| `pit-factory` | [`factory/`](factory/) | The launchpad: publishes the coin code once, creates `<symbol>.<factory>` coins | One account, keys deleted after deploy |
| `mock-pool` | [`mock-pool/`](mock-pool/) | Staking-pool stand-in with instant rewards and 60 s unbonding | **Test only** (sandbox, testnet) |
| `mock-agent-registry` | [`mock-agent-registry/`](mock-agent-registry/) | Shade Agent registry stand-in; owner whitelists agents | **Test only** |

`deploy.mjs` refuses both mocks on mainnet.

## The coin contract, by module

| Module | Responsibility |
|---|---|
| [`lib.rs`](pit/src/lib.rs) | Crate overview, contract state, `new` (Borsh init args), brain/thinker roles |
| [`trading.rs`](pit/src/trading.rs) | `buy`, `buy_with_pass`, `buy_with_agent_pass` (+ registry callback), `sell`; pass checks; curve math |
| [`payouts.rs`](pit/src/payouts.rs) | Sell queue (`process_queue`), harvest claims, refund credits; recovery after a confirmed failed transfer |
| [`staking.rs`](pit/src/staking.rs) | `rebalance` → pool view → one stake / unstake / withdraw, under a lock that only callbacks release |
| [`mind.rs`](pit/src/mind.rs) | Memories adopted by conviction (tokens × time); `record_thought` verifies NEAR AI Ed25519 signatures |
| [`views.rs`](pit/src/views.rs) | Quotes, `brain_stats`, `curve_info`, launch info, queue, memories, thoughts |
| [`token.rs`](pit/src/token.rs) | NEP-141 transfers, NEP-145 storage management, NEP-148 metadata |
| [`types.rs`](pit/src/types.rs), [`external.rs`](pit/src/external.rs), [`constants.rs`](pit/src/constants.rs), [`util.rs`](pit/src/util.rs) | Data types, pool and registry interfaces, limits and error labels, helpers |

Key invariants (enforced in code, checked by `tests/fuzz.rs` after every operation):

1. **Solvency**: liquid + staked + unstaking ≥ principal + queued payouts.
2. **Curve bound**: selling the entire supply never pays more than `principal`.
3. **Token conservation**: balances sum to total supply.
4. **Escrow**: the contract's own token balance equals outstanding memory backings.
5. **Queue**: queued debt equals the sum of open tickets.

Every transfer the contract sends (payouts, harvests, refunds) stays locked
until its callback confirms success; nothing is resent because time passed.

## Build

```bash
node ../scripts/build.mjs
```

Outputs `*/target/near/*.wasm`. Record sizes and SHA-256 for deployment with
`npm run artifacts` from the repository root.

## Test

```bash
cargo test --features unit-tests                 # host tests (in pit/ and factory/)
cargo test --features integration --test integration   # sandbox: real wasm on a local NEAR node
```

Sandbox tests need the wasm built first and a `near-sandbox` binary
(`NEAR_SANDBOX_BIN_PATH`, or let `near-workspaces` download one).

| Test file (coin) | What it covers |
|---|---|
| `unit.rs` | Curve math, buys, sells, queue, staking accounting, harvest, storage |
| `launch.rs` | Every pass rule, caps and phase |
| `agent.rs` | Shade-agent passes: registry outcomes, refunds, replay while in flight |
| `mind.rs` | Memories, conviction, adoption floor, Proof-of-Thought signature checks |
| `recovery.rs` | Failed-transfer recovery, refund credits, NEP-145 behaviour |
| `pool_result.rs` | A pool success that returns data is booked as success |
| `fuzz.rs` | 5 seeds × 2,000 random operations, invariants checked after each |
| `init_abi.rs`, `thought_abi.rs` | JS encoders (deploy script, brain) match the contract's Borsh layout byte for byte |
| `integration.rs` | Sandbox: stake → reward → harvest → sell, gated buys, Shade registry, the mind, failed-transfer recovery |

Factory: `tests/config.rs` (config validation, refund claims and retries) and
`tests/integration.rs` (sandbox: publish, launch, image icons, agent-pass buy, harvest split).

Full interface and mechanics: [`../README.md`](../README.md).
