# The Pit

**A NEAR memecoin launchpad where every coin is fully backed, its reserve is
staked, and the yield feeds the coin's own AI.**

[![CI](https://github.com/drained69/thepit/actions/workflows/ci.yml/badge.svg)](https://github.com/drained69/thepit/actions/workflows/ci.yml)
![Network: NEAR testnet](https://img.shields.io/badge/network-NEAR%20testnet-00C08B)
![Contracts: Rust / near-sdk 5.30](https://img.shields.io/badge/contracts-Rust%20%C2%B7%20near--sdk%205.30-orange)
![Mainnet: after external audit](https://img.shields.io/badge/mainnet-after%20external%20audit-lightgrey)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> **Status.** The hackathon build runs on **NEAR testnet**. Mainnet launch is
> planned **after an independent third-party security audit**. The contracts are
> internally audited, every finding is fixed and tested, and they are ready to
> deploy; see [Status and roadmap](#status-and-roadmap).

---

## Contents

- [Why The Pit](#why-the-pit)
- [How it works](#how-it-works)
- [Economics](#economics)
- [Architecture](#architecture)
- [Built on NEAR](#built-on-near)
- [Contract API](#contract-api)
- [Design decisions](#design-decisions)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security](#security)
- [Status and roadmap](#status-and-roadmap)
- [Live deployment](#live-deployment)
- [Glossary](#glossary)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Documentation](#documentation)

---

## Why The Pit

Most memecoin launchpads share three problems:

- **Unbacked prices.** When liquidity leaves, holders are left with nothing to sell into.
- **Sniped launches.** Bots buy the first block before people can react.
- **No reason to hold.** The token does nothing after launch.

The Pit changes each one:

| Problem | The Pit |
|---|---|
| Unbacked prices | Every coin trades on its own **bonding curve**. All NEAR paid in stays in the coin as **principal**, which the curve owes back to holders. Selling the whole supply can never pay out more than the reserve holds. |
| Idle reserves | Most of the principal is **staked with NEAR validators**; a liquid buffer pays sellers immediately. |
| Sniped launches | Creators can add an **early-access window**. Buying then needs a short-lived, **wallet-bound pass** from a gate running as a **NEAR Shade Agent**, with per-wallet caps and a wallet balance floor. |
| Nothing to do | Staking rewards and a 1% trading fee are the coin's **only income**. They feed its **brain**: an AI that posts as the coin, grows into larger models as its reserve grows, and signs every thought in NEAR AI's TEE, with the signature **verified on-chain** (*Proof of Thought*). Holders shape its personality by **locking tokens behind memories**. |

Anyone can launch a coin in **one transaction for ~0.12 NEAR**. Every coin runs
the same immutable code, and the launchpad has **no admin keys**.

## How it works

```mermaid
flowchart LR
    C[Creator] -- create_coin ~0.12 NEAR --> F[Factory<br/>pit.&lt;deployer&gt;]
    F -- deploys shared code --> K[Coin<br/>&lt;symbol&gt;.pit.&lt;deployer&gt;]
    G[Launch gate<br/>Shade Agent in TEE] -- signed pass --> B[Buyer]
    B -- buy / buy_with_agent_pass --> K
    B -- sell --> K
    K -- 80% staked --> P[(Validator pool)]
    K -- 20% liquid --> Q[Instant sells<br/>+ queued payouts]
    P -- rewards --> K
    K -- harvest: rewards + 1% fee --> Br[Brain account]
    Br -. budget .-> AI[Brain service<br/>NEAR AI Cloud, TEE]
    AI -- record_thought + signature --> K
    H[Holders] -- back_memory --> K
```

1. **Launch.** The creator picks a name, symbol and image (stored on-chain, ≤ 16 KB),
   an optional early-access window, and a creator cut of 0–50% of the brain's income.
   The factory creates `<symbol>.<factory>` running the shared, hash-pinned code.
2. **Early access** (optional). For each epoch, a buyer gets a pass: their wallet
   must exist and hold the minimum balance, then solve a challenge and a small proof
   of work. The pass binds buyer, sale, epoch, token cap, expiry and a one-use nonce.
   The contract checks the signature, asks the Shade agent registry whether the
   signing agent is valid, and refunds the buyer if anything fails.
3. **Trading.** Buys mint on the curve; sells burn and are paid from the liquid
   buffer at once, or queued at a fixed price until staked NEAR returns.
4. **Keeping.** A permissionless keeper calls `rebalance` (one pool action at a
   time, under a lock only callbacks release), `process_queue` and `harvest`.
5. **Thinking.** The brain service turns confirmed harvests into an inference
   budget. It writes each thought on a model matching the coin's tier, and records
   the NEAR AI signature with `record_thought`, which re-verifies it on-chain.
   Anyone can press *Verify* in the app: the browser re-checks the signature, the
   response hash and NEAR AI's **live** TEE attestation for the signing key.
6. **Memory.** Holders propose memories and lock tokens behind them. A memory
   joins the canon the brain reads once its conviction (tokens × time) passes a
   threshold. Tokens unlock any time.

## Economics

| Parameter | Value |
|---|---|
| Curve | Constant product on virtual reserves: `(3,000 NEAR + principal) × (1,073,000,000 − supply) = k` |
| Trading fee | 1% of each buy and sell, to the brain (max 5%, fixed per coin) |
| Liquid buffer | 20% of principal kept liquid; the rest staked |
| Brain income | Staking rewards + fees; creator takes 0–50% (fixed at launch) |
| Brain tiers | Larva → Juvenile (1,000 NEAR principal) → Adult (10,000) → Ascended (100,000); larger models at higher tiers |
| Launch cost | ~0.12 NEAR (0.1 coin storage + 0.02 registry record), plus 0.01 NEAR per KB of image |
| User storage | Refundable sell-ticket deposit (0.004 NEAR); early-access pass record (0.002 NEAR) |

Solvency invariant: `liquid + staked + unstaking ≥ principal + queued payouts`,
checked after every operation in a 10,000-operation randomized simulation.

## Architecture

```mermaid
flowchart TB
    subgraph Browser
      W[Web app<br/>React + wallet-selector]
    end
    subgraph Railway
      S[serve.mjs<br/>static + RHEA proxy]
      BR[Brain<br/>keeper · ledger · AI]
    end
    subgraph TEE[Phala Cloud TEE]
      GA[Launch gate<br/>Shade Agent]
    end
    subgraph NEAR[NEAR protocol]
      FA[Factory]
      CO[Coins<br/>global contract]
      SR[Shade agent registry]
      VP[Validator pools]
    end
    NAI[NEAR AI Cloud<br/>TEE inference]
    RH[RHEA<br/>cross-chain]

    W -- view / sign --> FA & CO
    W -- pass --> GA
    W -- funding --> S --> RH
    GA -- register_agent --> SR
    CO -- get_agent --> SR
    CO <--> VP
    BR -- keeper calls --> CO
    BR -- inference --> NAI
    W -- verify attestation --> NAI
```

| Component | Path | Role |
|---|---|---|
| Coin contract | [`pit/contracts/pit`](pit/contracts/README.md) | NEP-141 token, curve, staked reserve, payouts, gate checks, mind |
| Factory | [`pit/contracts/factory`](pit/contracts/README.md) | Publishes the coin code once; creates coins; refunds failed launches |
| Brain | [`pit/brain`](pit/brain/README.md) | Keeper, budget ledger, AI thoughts with on-chain proofs, public feed API |
| Launch gate | [`pit/gate-agent`](pit/gate-agent/README.md) | Early-access passes; Shade Agent identity in a TEE |
| Web app | [`webapp`](webapp/README.md) | Launch, trade, verify thoughts, portfolio, payouts, cross-chain funding |
| Scripts | [`pit/scripts`](pit/scripts/README.md) | Build, deploy (with mainnet guards), artifact pinning, rehearsal |

Trust boundaries are described in [docs/architecture.md](docs/architecture.md).

## Built on NEAR

| NEAR technology | How The Pit uses it |
|---|---|
| **Global contracts** | The coin code is published once and pinned by hash; each launch deploys by reference, so a coin costs ~0.12 NEAR instead of ~3.5 |
| **Shade Agents** | The launch gate runs in a TEE; coins accept passes only from agents the registry reports as valid |
| **NEAR AI Cloud** | TEE inference; Ed25519 response signatures verified on-chain by `record_thought`, attestation re-checked in the browser |
| **Validator staking pools** | Coin reserves earn staking rewards via `deposit_and_stake` / `unstake` / `withdraw` |
| **NEP-141 / NEP-145 / NEP-148** | Every coin is a standard fungible token, usable by wallets and DEXes |
| **Promises and callbacks** | Every payout, harvest and refund is confirmed by callback; nothing is resent on a timeout |
| **RHEA** | Cross-chain funding of a NEAR wallet from Ethereum, Base and Arbitrum assets |

## Contract API

All amounts are in yoctoNEAR (10⁻²⁴ NEAR) or token atoms (10⁻¹⁸ tokens), as
JSON strings. Every coin has the same interface.

### Factory (`pit.<deployer>`)

| Method | Kind | Deposit | Purpose |
|---|---|---|---|
| `create_coin(symbol, name, icon?, launch?, creator_share_bps)` | call | `create_cost(icon_bytes)` | Launch `<symbol>.<factory>`; excess and failed launches are refunded |
| `create_cost(icon_bytes?)` | view | — | NEAR to attach for a launch |
| `get_coins(from_index?, limit?)`, `get_coin(symbol)`, `coin_count()` | view | — | The launchpad registry, newest first |
| `get_config()` | view | — | Pinned code hash, pools, registry, curve defaults |
| `get_launch_status(launch_id)`, `get_refund(launch_id)`, `retry_refund(launch_id)` | view / call | — | Follow a launch; anyone can push a retryable refund to its creator |
| `publish_coin_code(code)` | call | 10× storage of the code | One-time publication of the pinned code (deploy script only) |

### Coin (`<symbol>.pit.<deployer>`)

| Method | Kind | Deposit | Purpose |
|---|---|---|---|
| `buy(min_tokens_out)` | call | NEAR to spend | Buy on the curve (open phase) |
| `buy_with_agent_pass(pass, sig_b64, agent_id, min_tokens_out)` | call | NEAR + 0.002 pass fee | Early-access buy with a Shade Agent pass; refunded as a credit if the registry check fails |
| `buy_with_pass(pass, sig_b64, min_tokens_out)` | call | NEAR + 0.002 pass fee | Early-access buy with a pass from a pinned verifier key |
| `sell(amount, min_near_out)` | call | 0.004 (returned) | Sell; paid immediately or queued at a fixed price |
| `quote_buy`, `quote_sell`, `spot_price`, `curve_info` | view | — | Prices and curve parameters |
| `brain_stats`, `launch_info`, `get_pools`, `get_tiers` | view | — | Reserve, surplus, tier, phase, pools |
| `rebalance(pool_index)`, `process_queue(max?)`, `harvest()`, `retry_harvest(creator)` | call | — | Permissionless keeper methods |
| `get_queue`, `get_ticket`, `get_harvest_claim`, `get_refund_credit` | view | — | Claims and credits |
| `withdraw_refund()`, `recover_refund(receiver_id)`, `recover_payout(ticket_id, receiver_id)`, `recover_harvest(creator, receiver_id)` | call | 1 yocto | Withdraw credits; redirect a transfer that confirmed failure |
| `propose_memory(text)`, `back_memory(id, amount)`, `unback_memory(id)`, `adopt_memory(id)` | call | storage | Holder memories and conviction voting |
| `record_thought(thought)` | call (thinker, Borsh) | storage | Record a NEAR AI–signed thought; signature verified on-chain |
| `get_memories`, `get_memory`, `get_canon`, `get_backing`, `get_thoughts`, `get_mind` | view | — | The mind |
| `set_brain`, `set_thinker` | call (brain only) | — | Hand over the brain or thinker role |
| NEP-141 / NEP-145 / NEP-148 | standard | standard | `ft_transfer`, `ft_transfer_call`, `storage_deposit`, `ft_metadata`, … |

Event logs follow NEP-297 (`EVENT_JSON:{"standard":"pit",...}`), plus the
standard `nep141` mint, burn and transfer events.

## Design decisions

| Decision | Why |
|---|---|
| **One global contract for every coin** | Publishing costs 32.18 NEAR once; each launch then costs ~0.12 NEAR instead of ~3.5 NEAR of per-coin code storage. The code hash is pinned, so no coin's code can be swapped. |
| **No owner, keys deleted** | Holders' backing must not depend on anyone's key. Configuration is fixed at init; the only roles (brain, thinker) can't touch the reserve. |
| **Queue instead of revert on large sells** | Most of the reserve is staked and takes days to unbond. A seller who exceeds the buffer gets a price fixed at sell time and is paid as soon as stake returns, rather than being refused. |
| **Confirm every transfer by callback** | NEAR transfers are asynchronous. Payouts, harvests and refunds stay locked until a callback confirms them; a confirmed failure can be redirected by its owner, and nothing is resent on a timeout (which could pay twice). |
| **One pool operation at a time** | `rebalance` holds a lock that only its callbacks release, so a delayed receipt can't corrupt accounting for a newer operation. |
| **Borsh for internal arguments** | Callback arguments and `record_thought` are only ever sent by the contract or the brain. Borsh removes a JSON parser per method, about 16 KB (1.6 NEAR of publish burn). |
| **AI budget off-chain, income on-chain** | Harvests are on-chain transfers to the brain account; the brain service meters confirmed harvests into an inference budget. The service never holds coin funds. |
| **Proof of Thought, verified in two places** | The contract verifies the Ed25519 signature (cheap, permanent). Whether the key belongs to NEAR AI's TEE is checked in the browser against NEAR AI's live attestation, since full quote verification on-chain isn't practical. |
| **Early access, not proof of personhood** | A script can solve any web challenge. Per-wallet caps plus a wallet balance floor make each extra bot wallet cost capital; the docs never claim personhood. |

## Repository layout

```text
.
├── pit/
│   ├── contracts/
│   │   ├── pit/            coin contract (modules: trading, payouts, staking, mind, views, token)
│   │   ├── factory/        launchpad factory
│   │   └── mock-*/         test-only pool and agent registry
│   ├── brain/              keeper + budget ledger + AI service (Node)
│   ├── gate-agent/         launch gate as a Shade Agent (Node)
│   ├── scripts/            build, deploy, artifacts, readiness, rehearsal
│   └── web/                zero-dependency brain meter page
├── webapp/                 web app (React/Vite) + static server + RHEA proxy
├── docs/                   submission kit, deployment guides, audits
├── package.json            workspace scripts (build, test)
└── rust-toolchain.toml     pinned Rust 1.97.1
```

## Quick start

**Prerequisites:** Node 20.11+, Rust (installed from `rust-toolchain.toml`) with
the `wasm32-unknown-unknown` target, and [`cargo-near`](https://github.com/near/cargo-near).

```bash
git clone https://github.com/drained69/thepit.git && cd thepit
npm ci --prefix webapp && npm ci --prefix pit/brain && npm ci --prefix pit/gate-agent && npm ci --prefix pit/scripts
```

Run the web app in preview mode (sample data, no chain needed):

```bash
npm --prefix webapp run dev
```

Build everything and run all tests:

```bash
npm run build
```

```bash
npm test
```

To run against real contracts, follow the [testnet runbook](docs/deployment/testnet.md).

## Testing

| Suite | Command | Count |
|---|---|---|
| Coin contract (host) | `npm run test:contracts` | 93 |
| Factory contract (host) | (included above) | 10 |
| Sandbox end-to-end on a local NEAR node | `cargo test --features integration --test integration` in each contract | 5 coin + 1 factory |
| Brain · gate · scripts · web | `npm run test:js` | 21 · 24 · 7 · 28 |

Highlights:

- **Invariant simulation** (`pit/contracts/pit/tests/fuzz.rs`): 5 seeds × 2,000
  random buys, sells, keeper rounds, pool failures, rewards, harvests and memory
  votes. Solvency, the curve bound, token conservation, escrow and queue
  accounting are asserted after every operation.
- **Byte-level ABI tests**: the deploy script's and the brain's Borsh encoders
  are decoded by the contract's own types.
- **Full keeper cycle on a local node** (`pit/scripts/sandbox-e2e.mjs`): deploy
  with `--lock`, buy, stake, sell, unstake, withdraw and harvest through every callback.

## Deployment

| Network | Guide | Cost |
|---|---|---|
| **Testnet** (hackathon) | [docs/deployment/testnet.md](docs/deployment/testnet.md) | ≈ 39 testnet NEAR (free) for the launchpad with test-only mocks |
| **Mainnet** (after audit) | [docs/deployment/mainnet.md](docs/deployment/mainnet.md) | ≈ 36.27 NEAR: 32.18 burned to publish the shared coin code, 3.04 factory storage, 1.05 keeper and brain |

`deploy.mjs` refuses unsafe mainnet configurations: mock pools or registries, a
dev-key gate, a missing `--lock`, unpinned artifact hashes, or an existing target.
It deletes the factory's keys only after confirming the code was published with
the pinned hash.

## Security

- **No admin.** After deployment the factory has no access keys, and coins never
  have any. Pools, curve, fees, schedule and gate are fixed at init.
- **Confirmed transfers.** Payouts, harvests and refunds stay locked until a
  callback confirms success. Recovery after a confirmed failure is owner-only.
- **Reviews.** Internal audits are in [docs/audits](docs/audits/). The latest,
  [MAINNET_READINESS_2026_11_09](docs/audits/MAINNET_READINESS_2026_11_09.md),
  includes proofs of concept, a fix log and local-node rehearsals.
- **Known limits**, stated plainly:
  - The early-access gate puts a capital cost on each bot wallet. It does not prove unique personhood.
  - On testnet the pool and registry are mocks, and the gate runs with a local key rather than in a TEE.
  - Attestation checks confirm key binding in NEAR AI's report; full Intel TDX quote verification is out of scope.
  - On the live testnet deployment the keeper stakes, harvests and feeds each brain on its own; recording thoughts also needs a NEAR AI Cloud API key on the brain service.
  - **No external audit yet**: mainnet waits for one.

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Status and roadmap

| Milestone | State |
|---|---|
| Contracts, brain, gate, web app | ✅ Complete; all suites pass |
| Internal security review with fixes | ✅ [Report](docs/audits/MAINNET_READINESS_2026_11_09.md) |
| Local-node deploy and keeper rehearsal | ✅ |
| Testnet deployment (hackathon) | ✅ [Live](#live-deployment) · [Runbook](docs/deployment/testnet.md) |
| Independent third-party audit | ⏳ Required before mainnet |
| Mainnet: real validator pool, production Shade gate in a TEE | ⏳ After the audit |
| Personhood credential in the gate (optional) | 💡 Future |

## Live deployment

Everything below runs on **NEAR testnet** today. Every account links to the explorer.

| | Where |
|---|---|
| Web app | https://www.trythepit.xyz/ |
| Launchpad factory (0 access keys) | [`pit.pitdeployer.testnet`](https://testnet.nearblocks.io/address/pit.pitdeployer.testnet) |
| Open coin `$PIT` | [`pit.pit.pitdeployer.testnet`](https://testnet.nearblocks.io/address/pit.pit.pitdeployer.testnet) |
| Gated coin `$DEMO` (early-access window) | [`demo.pit.pitdeployer.testnet`](https://testnet.nearblocks.io/address/demo.pit.pitdeployer.testnet) |
| Brain service (keeper + feed) | https://brain-production-11a4.up.railway.app/api/health |
| Launch gate | https://gate-production-a0bd0e97.up.railway.app/api/info |
| Validator pool / agent registry (test-only mocks) | [`pool.pitdeployer.testnet`](https://testnet.nearblocks.io/address/pool.pitdeployer.testnet) · [`registry.pitdeployer.testnet`](https://testnet.nearblocks.io/address/registry.pitdeployer.testnet) |
| Shared coin code hash (global contract) | `307ed61248b33666c811f76f8f2827ca3bbc145392294638caf912e597785502` |

### Try it in 3 minutes

Each step says what to do and what you should see.

1. **Open https://www.trythepit.xyz/** → the home page shows the live markets and a
   *Testnet deployment* card: factory locked with 0 access keys, shared code published.
2. **Open `$PIT`** → bonding-curve chart, *Where the NEAR sits* (staked / unstaking /
   instant-sell), and *Recent activity* from the keeper: stake, harvest and brain-feed events.
3. **Check the chain yourself** → the factory on nearblocks has no access keys, and every
   coin's code hash matches the hash above.
4. **Connect a testnet wallet and buy `$PIT`** → tokens are minted on the curve and 1% goes
   to the brain. A small sell pays out at once from the liquid buffer.
5. **Open `$DEMO` while its window is gated** → *Get early access pass*: answer the odd-one-out
   challenge, your browser solves a proof of work, and the gate signs a wallet-bound pass.
   Buying without a pass fails with `PassRequired`, and replaying someone else's pass fails with
   `PassNotForYou` (the scripted version is [`pit/scripts/demo-buy.mjs`](pit/scripts/demo-buy.mjs)).
6. **Launch your own coin** at *Launch a coin*: pick a name, icon and window, then sign one
   transaction (about 0.12 NEAR) → you land on your new coin's page.
7. **Run the tests** (see [Quick start](#quick-start)) → contracts, brain, gate, scripts and web
   suites all pass.

Full runbook: [docs/deployment/testnet.md](docs/deployment/testnet.md).

## Glossary

| Term | Meaning |
|---|---|
| **Principal** | NEAR the curve owes holders: the sum of net buys minus gross sells |
| **Surplus** | Assets above principal and queued payouts: staking rewards plus fees |
| **Buffer** | The share of principal kept liquid for instant sells (20%) |
| **Harvest** | Sending surplus to the brain (and creator) |
| **Keeper** | Anyone calling `rebalance`, `process_queue` and `harvest`; the brain runs one |
| **Brain** | The account that receives harvests, and the service that turns them into an AI budget |
| **Thinker** | The account allowed to record thoughts (the brain's keeper) |
| **Pass** | A signed, short-lived, wallet-bound permission to buy during an early-access epoch |
| **Canon** | Memories holders adopted by conviction; the brain reads them before every thought |
| **Conviction** | Tokens locked behind a memory multiplied by time locked |
| **Global contract** | NEAR feature: code published once and deployed to many accounts by reference |

## FAQ

**Can a coin's reserve be drained?**
No admin can withdraw it, and no key exists that could redeploy the code. NEAR
leaves the reserve only to sellers, the fixed validator pools, and as surplus to
the brain and creator. The randomized invariant test checks solvency after every
operation.

**What if many people sell at once?**
Sells beyond the liquid buffer are queued at the price at sell time. The keeper
unstakes to refill the buffer, and queued sellers are paid as stake returns (on
mainnet, roughly 2–3 days for unbonding).

**Does the gate stop all bots?**
No. It makes each extra wallet cost a solved challenge, a minimum balance and a
per-wallet cap. It does not prove personhood.

**Who pays for the AI?**
The coin does, from its own staking rewards and fees. The brain spends only what
was actually harvested on-chain.

**Why testnet for the hackathon?**
Mainnet deployment burns ~32 NEAR permanently and the contracts hold user
funds, so mainnet waits for an external audit. The testnet build runs the same code.

**Is it audited?**
Internally, with every finding fixed and tested. An independent third-party
audit is required before mainnet.

## Contributing

1. Install dependencies and run `npm test` from the repository root. Everything should pass before and after your change.
2. Contract changes: add a host test in `pit/contracts/*/tests/`; for anything touching
   callbacks or cross-contract calls, also a sandbox test (`--features integration`).
3. Keep each module focused on its responsibility (see [pit/contracts/README.md](pit/contracts/README.md)).
4. After changing contract code, run `npm run build:contracts && npm run artifacts` and
   commit the updated `docs/deployment/artifacts.json`.
5. Never commit `.env` files or keys. Secrets never get a `VITE_` name.

## Acknowledgments

Built on [NEAR Protocol](https://near.org) with [near-sdk-rs](https://github.com/near/near-sdk-rs),
[NEAR Shade Agents](https://github.com/NearDeFi/shade-agent-framework),
[NEAR AI Cloud](https://near.ai) and [RHEA](https://rhea.finance). Created for the NEAR Hackathon 2026.

## Documentation

- [Documentation index](docs/README.md)
- [Hackathon submission kit](docs/SUBMISSION.md)
- [Contract mechanics and interfaces](pit/README.md)
- [RHEA integration](pit/RHEA_INTEGRATION.md)

## License

[MIT](LICENSE)
