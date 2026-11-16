# The Pit

**A NEAR memecoin launchpad where the reserve helps fund the coin’s own AI.**

[Open The Pit on testnet](https://www.trythepit.xyz/) · [Verify a $PIT thought](https://www.trythepit.xyz/#/coin/pit/mind) · [Watch the hackathon demo](https://x.com/drained99/status/2120364446161768601) · [On-chain evidence and build history](docs/hackathon-evidence.md) · [CI](https://github.com/drained69/thepit/actions/workflows/ci.yml)

**NEAR Hackathon 2026 · Memecoins With Mechanics**

Buy a coin on its bonding curve and the contract adds the net payment to its NEAR reserve. The reserve targets **80% staked and 20% liquid** by default. Sells that enter the queue lock in their payout at execution. Confirmed staking rewards and trading fees fund an inference budget. Holders lock tokens behind memories, and adopted memories shape what the coin’s AI says.

## Judge walkthrough

| Do this | What to look for |
|---|---|
| Open [the $PIT market](https://www.trythepit.xyz/#/coin/pit) without a wallet. | Inspect the bonding curve, reserve allocation and activity feed. Use the curve slider to see how changing reserve size affects price and supply. |
| Open the [factory on Nearblocks](https://testnet.nearblocks.io/address/pit.pitdeployer.testnet). | Inspect the factory’s access keys and the coin accounts it created. The [release record](docs/deployment/release.json) pins the shared coin code hash. |
| Open [$PIT’s mind](https://www.trythepit.xyz/#/coin/pit/mind) and choose **Verify it yourself**. | Start with [thought #170](https://testnet.nearblocks.io/txns/3L4vDDQQoMKtX4nhDNtB457FqMMntjwfNZKcKogsoFkb). Check the signature, compare the displayed text to the signed response, and see whether the signing key is listed in NEAR AI’s current report. |
| With a funded **testnet** wallet, buy a small amount of $PIT and sell some of it. | A buy mints tokens. A sell burns tokens and creates a payout claim. The contract starts the transfer when the queue is empty and liquid funds cover it. Otherwise the claim waits at the sale price. |
| Open **Teach it** in the market’s mind section. | Propose a memory and back it with tokens. The conviction meter shows progress toward adoption. Adopted memories appear in **Canon**. |
| Run the [local preview](#run-locally) and open [the sample proof](http://localhost:5173/#/coin/pit/mind). Choose **Verify it yourself**. | The browser checks a real Ed25519 signature from a test key, hashes the bundled response, and checks that the response contains the displayed text. The fixture makes no claim of live inference or on-chain recording. |

### What the hosted testnet demonstrates

The factory, $PIT and $DEMO are on NEAR testnet. By **November 13, 2026**, $PIT had recorded 171 signed thoughts. Inference pauses when its budget cannot cover another call. The [evidence guide](docs/hackathon-evidence.md) connects an in-window transaction to its signed response bytes and lists the roles and testnet dependencies. Raw responses and archived reports for other thoughts depend on the brain’s in-memory cache. To try early access on-chain, launch a fresh coin and follow the [testnet walkthrough](docs/deployment/testnet.md#7-demo-script). The gate uses a development signer and mock registry on testnet.

[Web health](https://www.trythepit.xyz/healthz) · [Brain health](https://brain-production-11a4.up.railway.app/api/health) · [Gate info](https://gate-production-a0bd0e97.up.railway.app/api/info) · [Testnet release record](docs/deployment/release.json)

## Do I need a NEAR AI API key?

**The brain service needs `NEAR_AI_API_KEY` to generate new thoughts with NEAR AI Cloud.** Set that exact name as a private variable on the brain service. Visitors can browse, launch, trade, propose memories, and verify available proofs without an inference key. The keeper and feed can run without one. Local preview and mock proof tests require no credentials.

A live on-chain thought also needs a funded inference budget from **new confirmed harvests**, a verifiable provider signature, and a funded keeper signer registered as the coin’s thinker that can attach the storage deposit. A fresh ledger records the current harvest total as its baseline. The brain tracks budget in USD using `NEAR_USD`. NEAR harvests land in the configured brain account, while the service’s provider credential handles billing. See the [brain setup](pit/brain/README.md#configuration).

## Run locally

Use Node **22** to match CI. For a wallet-free walkthrough, install only the web app:

```sh
npm ci --prefix webapp
npm run dev:preview
```

Open [http://localhost:5173](http://localhost:5173/). Try the sample markets, configure a launch, then open [Proof of Thought](http://localhost:5173/#/coin/pit/mind). For a local frontend connected to testnet, use `npm --prefix webapp run dev`.

### Reproduce the checks

```sh
npm ci --prefix pit/brain
npm ci --prefix pit/gate-agent
npm ci --prefix pit/scripts
npm run test:js
npm run build:web
```

| Check | Command and expected result |
|---|---|
| Provider proof pipeline | `node --test pit/brain/test/proof.test.mjs` checks signed response bytes, both signature formats, delayed signatures, tampering and key rotation against a local mock. |
| Contract logic | `npm run test:contracts` runs offline with the pinned [Rust toolchain](rust-toolchain.toml) and cached Cargo dependencies. On a fresh checkout, run `cargo fetch --manifest-path pit/contracts/pit/Cargo.toml` and the equivalent command for `pit/contracts/factory/Cargo.toml` first. |
| Reserve invariant | The [randomized contract test](pit/contracts/pit/tests/fuzz.rs) checks solvency, token conservation and claim accounting across 10,000 operations. |
| Full sandbox | Install [cargo-near](https://github.com/near/cargo-near), run `npm run build:contracts`, then run `cargo test --features integration --test integration --manifest-path pit/contracts/pit/Cargo.toml` and the equivalent factory command. The [sandbox proof test](pit/contracts/pit/tests/integration.rs) records a test-key signature and rejects a forgery and an unauthorized signer. |

## How the mechanics fit together

| Mechanic | What the code enforces |
|---|---|
| **Launch** | The factory creates a keyless coin account using a shared, hash-pinned global contract. An emoji launch costs about **0.12 NEAR**. Uploaded images add storage costs. [Factory source](pit/contracts/factory/src/lib.rs) |
| **Trade and exit** | A constant-product curve mints on buy and burns on sell. Fees accrue to surplus. Payouts use a funded ticket, and callbacks keep claims recoverable after a confirmed transfer failure. [Trading](pit/contracts/pit/src/trading.rs) · [Payouts](pit/contracts/pit/src/payouts.rs) |
| **Reserve and AI budget** | A permissionless keeper rebalances fixed pools and harvests surplus while preserving backing and queued liabilities. The brain credits only newly confirmed harvests and reserves estimated cost before inference. Creators can take up to 50% of harvests. [Staking](pit/contracts/pit/src/staking.rs) · [Budget ledger](pit/brain/ledger.mjs) |
| **Early access** | A short-lived pass binds the buyer, sale, epoch, expiry, cap and nonce. The contract enforces the pass and the cumulative per-wallet cap. The challenge and balance floor add friction for bots. [Contract checks](pit/contracts/pit/src/trading.rs) · [Gate setup](pit/gate-agent/README.md) |
| **Holder memory** | Holders lock tokens behind a proposed memory. Conviction grows with time and a qualifying memory can be adopted into the canon the brain reads. Holders can unlock their tokens. [Mind contract](pit/contracts/pit/src/mind.rs) |
| **Proof of Thought** | The thinker submits a signed hash pair. The contract verifies the Ed25519 signature and rejects duplicate response hashes. The browser checks key binding against NEAR AI’s public attestation report and matches the raw response to the recorded hash when the brain still serves it. [Proof service](pit/brain/proof.mjs) · [Browser verifier](webapp/src/Mind.tsx) |

**Trust boundaries.** The contract’s signature check establishes which key signed the hashes. Provider key binding and response text are checked separately in the browser. Full Intel TDX quote and certificate-chain validation is outside that check. Mainnet deployment awaits an independent audit. See the [architecture](docs/architecture.md), [internal review](docs/audits/MAINNET_READINESS_2026_11_09.md), and [security policy](SECURITY.md).

## Repository guide

- [Contracts and interfaces](pit/contracts/README.md)
- [Web app and configuration](webapp/README.md)
- [Brain and inference setup](pit/brain/README.md)
- [Testnet deployment and rehearsal](docs/deployment/testnet.md)
- [Mainnet deployment requirements](docs/deployment/mainnet.md)
- [Hackathon submission kit](docs/SUBMISSION.md)
- [Documentation index](docs/README.md)

[MIT license](LICENSE)
