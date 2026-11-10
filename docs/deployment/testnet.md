# Testnet deployment — the hackathon build

**The Pit is submitted to the NEAR Hackathon as a NEAR testnet deployment.
Mainnet launch is planned after an independent third-party security audit.**

Why testnet first:

- **Cost.** A mainnet launchpad needs ≈ 36.27 NEAR before gas, and 32.18 of
  that is burned permanently to publish the shared coin code
  ([details](#what-mainnet-would-cost)). Testnet NEAR is free.
- **Safety.** The contracts hold user funds and are immutable once locked.
  They have an internal audit, 93 contract tests, sandbox end-to-end runs and a
  10,000-operation invariant simulation, but no external audit yet
  ([audit report](../audits/MAINNET_READINESS_2026_11_09.md)).

Everything on testnet runs the **same contract code** that would go to
mainnet. The differences are the test-only helpers listed in
[What's test-only here](#whats-test-only-here).

---

## 1. What you need

| Need | Notes |
|---|---|
| A NEAR testnet account you control, e.g. `yourname.testnet` | Its private key goes in a local, git-ignored `pit/scripts/.env`. Never commit or paste it. |
| ~40 testnet NEAR for the launchpad (or ~6.5 for one coin) | See [Funding](#2-fund-the-account). |
| Rust 1.97.1 + `cargo-near`, Node 20.11+ | `rust-toolchain.toml` pins Rust. |
| Optional: a NEAR AI Cloud API key | Without it the brain keeps the reserve but doesn't think. |
| Optional: Railway CLI, logged in to project `the-pit` | To host web, brain and gate publicly. |

## 2. Fund the account

Testnet costs, computed by the same formula `deploy.mjs` funds accounts with:

| Launchpad (recommended for the demo) | Testnet NEAR |
|---|---|
| Publish shared coin code (burned) | 32.18 |
| Factory account | 3.04 |
| Mock validator pool (test-only) | 1.27 |
| Mock agent registry (test-only) | 1.40 |
| Keeper account | 1.00 |
| Brain account | 0.05 |
| First coin (optional) | 0.12 |
| **Total** | **≈ 39.04 + ~0.3 gas** |

| One coin, no launchpad (fallback) | Testnet NEAR |
|---|---|
| Coin account | 3.52 |
| Mock pool + mock registry (test-only) | 2.67 |
| Brain account | 0.05 |
| **Total** | **≈ 6.24 + ~0.1 gas** |

Faucet amounts change, and published figures disagree (from 1 to ~20 NEAR per
request). Check the amount on the [NEAR faucet](https://docs.near.org/tools/faucet)
page and plan for several requests. You can also send testnet NEAR from other
testnet accounts you own, or ask the hackathon organizers or NEAR DevRel.
If you can't reach ~40, use the one-coin fallback: same contracts, no launchpad.

## 3. Build and test locally

From the repository root:

```bash
npm ci --prefix webapp && npm ci --prefix pit/brain && npm ci --prefix pit/gate-agent && npm ci --prefix pit/scripts
```

```bash
npm run build:contracts
```

```bash
npm run test:brain && npm run test:gate && npm run test:scripts && npm run test:web
```

Contract tests (host and sandbox) are listed in [pit/README.md](../../pit/README.md#tests).

## 4. Deploy the contracts

Create `pit/scripts/.env` (git-ignored, mode 600):

```
DEPLOYER_ID=yourname.testnet
DEPLOYER_PRIVATE_KEY=ed25519:...
```

Deploy the launchpad, a test-only pool and registry, and lock the factory.
`--lock` deletes the factory's keys, as on mainnet, so even you can't change it
afterwards:

```bash
NEAR_NETWORK=testnet POOL=mock AGENT_REGISTRY=mock node pit/scripts/deploy.mjs --launchpad --lock
```

What it does, in order:

1. Builds the wasm.
2. Creates `pool.yourname.testnet` (mock pool, 60-second unbonding) and
   `registry.yourname.testnet` (mock agent registry).
3. Creates `pit.yourname.testnet`, deploys the factory, and initializes it.
4. Publishes the coin code. **It checks that publishing succeeded and the hash
   matches before going on.**
5. Creates `keeper.yourname.testnet` and writes its key to a private
   `pit/scripts/.keeper-testnet-*.env` (not printed).
6. With `FIRST_COIN=doge`, launches a first coin.
7. Deletes the factory's keys and confirms none remain.

It prints the Railway variables to use next.

For the one-coin fallback, drop `--launchpad`:

```bash
NEAR_NETWORK=testnet POOL=mock AGENT_REGISTRY=mock node pit/scripts/deploy.mjs --lock
```

## 5. Run the launch gate

Coins launched with an early-access window need the gate to issue passes. On
testnet it runs with a local signing key (`dev-key` mode) and registers in the
mock registry.

```bash
cd pit/gate-agent && GATE_IDENTITY=dev-key NEAR_NETWORK=testnet AGENT_CONTRACT_ID=registry.yourname.testnet SPONSOR_ACCOUNT_ID=yourname.testnet SPONSOR_PRIVATE_KEY=ed25519:... PORT=3140 npm start
```

It prints its agent account id (a 64-character hex implicit account). Allow it
in the mock registry:

```bash
NEAR_NETWORK=testnet AGENT_REGISTRY=registry.yourname.testnet node pit/scripts/registry-admin.mjs whitelist <agent id the gate printed>
```

Gate settings:

| Variable | Value |
|---|---|
| `GATE_DEV_SECRET` | Pin the gate's signing key across restarts (otherwise it's stored in `GATE_DEV_KEY_FILE` or regenerated, and must be whitelisted again). |
| `GATE_MIN_BALANCE_NEAR` | NEAR a buyer wallet must hold before it gets a challenge. Default `0` on testnet (wallet must exist), `1` on mainnet. |
| `TRUST_PROXY` | `1` when hosted behind Railway or another proxy. |

## 6. Host it (Railway)

| Service | Path | Variables |
|---|---|---|
| **web** | `webapp/` | `VITE_NEAR_NETWORK=testnet`, `VITE_PIT_FACTORY=pit.yourname.testnet`, `VITE_PIT_BRAIN_URL`, `VITE_PIT_GATE_URL`, `TRUST_PROXY=1`, optional server-only `RHEA_API_KEY` |
| **brain** | `pit/brain/` | `NEAR_NETWORK=testnet`, `PIT_FACTORY`, `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY` (from the private keeper file), optional `NEAR_AI_API_KEY` |
| **gate** (optional) | `pit/gate-agent/` | The gate variables above, with `GATE_DEV_SECRET` set |

```bash
railway up webapp --path-as-root --service web --detach
```

```bash
railway up pit/brain --path-as-root --service brain --detach
```

```bash
railway up pit/gate-agent --path-as-root --service gate --detach
```

Never give a secret a `VITE_*` name: those are built into the public bundle.
Deploy the brain together with these contracts. `record_thought` and internal
callbacks use Borsh, so an older brain or contract won't interoperate.

## 7. Demo script (≈ 5 minutes)

Record the explorer link for each step (`https://testnet.nearblocks.io`).

1. **Launch a coin.** On the web app, open *Launch a coin*. Upload an image,
   choose an early-access window and a creator cut, then sign. Show the coin
   page and its contract on nearblocks.
2. **Early access.** Get an early access pass (challenge + proof of work), then
   buy. Show the pass-gated buy and the per-wallet cap.
3. **Trade.** Buy more once open, then sell. The payout arrives in the same
   flow; show the *Payouts* panel.
4. **Reserve and brain.** Show the reserve bar (staked / liquid), the keeper's
   stake and harvest on nearblocks, and the brain feed.
5. **Proof of Thought** (with `NEAR_AI_API_KEY`). Open a thought and press
   *Verify it yourself*. The browser checks the signature, the response hash
   and NEAR AI's live TEE attestation.
6. **Mind.** Propose a memory and back it with tokens.
7. **No admin.** Show that `pit.yourname.testnet` has **0 access keys** on
   nearblocks.

## 8. Verify the deployment

Check the factory has no keys (an empty `keys` list):

```bash
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"pit.yourname.testnet"}}'
```

- [ ] Factory has 0 access keys; `get_config` shows `code_published: true` and
      the coin hash from `docs/deployment/artifacts.json`.
- [ ] A coin buy, sell and payout, and a keeper stake and harvest, appear on nearblocks.
- [ ] Web `/healthz`, brain `/api/health` and gate `/api/health` answer.
- [ ] No private keys, `.env` or `.keeper-*.env` files are in the public repository.

Local rehearsal without testnet NEAR: run a `near-sandbox` node, deploy with
`NEAR_NETWORK=sandbox DEPLOYER_ID=test.near`, then run
`node pit/scripts/sandbox-e2e.mjs <test.near secret>`. It drives buy, stake,
sell, unstake, withdraw and harvest through every contract callback.

## What's test-only here

| Piece | Testnet (hackathon) | Mainnet (after audit) |
|---|---|---|
| Validator pool | `mock-pool`: instant rewards, 60 s unbonding | A real `*.poolv1.near` pool, real unbonding (~2–3 days) |
| Agent registry | `mock-agent-registry`: the owner whitelists agents | NEAR Shade Agent contract with `requires_tee: true` |
| Gate identity | `dev-key`: a local Ed25519 key, **not in a TEE** | Shade Agent in a TEE on Phala Cloud |
| Gate wallet floor | Wallet must exist | Wallet must hold ≥ 1 NEAR |
| Contracts | Same code and hashes as mainnet | Same, after an external audit |

`deploy.mjs` refuses every test-only piece when `NEAR_NETWORK=mainnet`.

## What mainnet would cost

From `node pit/scripts/deploy.mjs --plan --launchpad` with the current artifacts:

| Item | NEAR | Recoverable? |
|---|---|---|
| Publish shared coin code | 32.18 | No: burned by the protocol |
| Factory storage | 3.04 | No: locked once the factory's keys are deleted |
| Keeper account | 1.00 | Yes |
| Brain account | 0.05 | Yes (it receives harvests) |
| **Total** | **≈ 36.27 + gas** | |

After launch, each new coin costs its creator ~0.12 NEAR (more with an image icon).

## Claims to make (and not make)

- ✅ "Deployed on **NEAR testnet**; mainnet after a third-party audit."
- ✅ "Every coin is fully backed by its staked reserve. A sell is paid from the liquid buffer at once, or queued at that price until staked NEAR returns."
- ✅ "Early-access window: wallet-bound passes, per-wallet caps, a wallet balance floor on mainnet."
- ✅ "Proof of Thought: NEAR AI signatures verified on-chain; TEE attestation checked in the browser against NEAR AI."
- ❌ "Bot-proof", personhood claims, "snipers get nothing". The gate adds cost per bot wallet; it doesn't prove personhood.
- ❌ "Audited" (say "internally audited; external audit before mainnet").
- ❌ "Production TEE gate" on testnet (it runs in `dev-key` mode).
