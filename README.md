# The Pit

A NEAR memecoin launchpad with bonding-curve trading, staking-backed reserves,
recoverable payouts, a gated launch option, and an AI brain funded by confirmed
harvests. RHEA cross-chain funding connects eligible EVM assets to a NEAR wallet;
wallet funding and purchasing a coin are separate transactions.

## Status

| | |
|---|---|
| **Hackathon build** | NEAR **testnet** ([runbook](docs/deployment/testnet.md), [submission kit](docs/SUBMISSION.md)) |
| **Mainnet** | Planned **after an independent third-party audit** ([guide](docs/deployment/mainnet.md)) |
| **Security** | Internal audit, every finding fixed and tested ([report](docs/audits/MAINNET_READINESS_2026_11_09.md)); no external audit yet |
| **Tests** | 93 coin + 10 factory contract tests, 6 sandbox end-to-end runs, a 10,000-operation invariant simulation, 80 service and web tests |
| **Mainnet cost** | ≈ 36.25 NEAR to deploy the launchpad (32.16 permanently burned to publish shared code); then ~0.12 NEAR per coin |

On testnet the validator pool and agent registry are test-only mocks, and the
launch gate runs with a local key rather than in a TEE. The gate adds a cost
per bot wallet; it does not prove unique personhood.

## Project layout

| Directory | Purpose |
|---|---|
| `webapp/` | React/Vite application, static server, same-origin RHEA proxy and tests |
| `webapp/src/pit/` | Launch, trading, funding, memory and payout recovery UI |
| `webapp/server/` | Server-only API credential handling and resource controls |
| `pit/contracts/pit/` | Token, reserve, claims, staking and memories |
| `pit/contracts/factory/` | Launchpad and recoverable creation refunds |
| `pit/contracts/mock-*/` | Sandbox fixtures; never mainnet dependencies |
| `pit/brain/` | Keeper, confirmed-harvest budget ledger and inference service |
| `pit/gate-agent/` | Gate service and Shade identity integration |
| `pit/scripts/` | Build, deployment, read-only readiness and developer scripts |
| `docs/audits/` | Dated security findings and verification evidence |
| `docs/deployment/` | Testnet runbook, mainnet guide, artifact hashes |
| `docs/human/` | Docs for the earlier $HUMAN prototype |
| `contracts/human-sale/`, `tee-gate/`, `scripts/` | Earlier $HUMAN prototype; see `README.human.md` |

## Development

Node 20.11+ is required for the application. Install each service's locked
packages with `npm ci` in its directory; services intentionally keep independent
lockfiles and Railway build roots. The Rust contracts use cargo-near; see the
contract build instructions in [pit/README.md](pit/README.md).

```sh
npm run build:web
npm run test:web
npm run test:brain
npm run test:gate
npm run test:scripts
npm run build:contracts
```

Node tests may open local mock HTTP servers. No test command above sends a
funded mainnet transaction. Sandbox integration tests require their feature and
the WASM artifacts; they are documented in the contract test files.

- [Hackathon submission kit](docs/SUBMISSION.md)
- [Testnet deployment and demo runbook](docs/deployment/testnet.md)
- [Mainnet deployment guide](docs/deployment/mainnet.md) (after the external audit)
- [Mainnet readiness audit, 2026-11-09](docs/audits/MAINNET_READINESS_2026_11_09.md); earlier reports in [docs/audits](docs/audits/)
- [Architecture and trust boundaries](docs/architecture.md)
- [Contracts, mechanics and interfaces](pit/README.md)
- [RHEA integration and verification limits](pit/RHEA_INTEGRATION.md)

Secrets belong in server environment variables or private ignored files, never
`VITE_*`, committed source, logs or screenshots. Deployment tooling saves newly
generated keeper credentials to a private ignored file instead of printing keys.
