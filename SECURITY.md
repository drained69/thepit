# Security policy

## Status

The Pit runs on **NEAR testnet** only. The contracts have had internal reviews
([docs/audits](docs/audits/)); mainnet deployment waits for an independent
third-party audit. Testnet tokens have no value.

## Reporting a vulnerability

Please report privately, not in a public issue: use **Security → Report a
vulnerability** on this repository, or contact the repository owner directly.
Include the affected component (coin contract, factory, brain, gate or web app),
steps to reproduce, and the impact you expect.

## Scope

| In scope | Out of scope |
|---|---|
| `pit/contracts/pit`, `pit/contracts/factory` | `pit/contracts/mock-pool`, `pit/contracts/mock-agent-registry` (test-only) |
| `pit/brain`, `pit/gate-agent`, `webapp` | Third-party services (NEAR AI Cloud, RHEA, wallets, Railway) |

Known, documented limits (for example, the early-access gate does not prove
unique personhood) are listed in the README's [Security](README.md#security) section.
