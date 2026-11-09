# Scripts — build, deploy and operate

| Script | Purpose |
|---|---|
| [build.mjs](build.mjs) | Build every contract with `cargo near build` |
| [artifacts.mjs](artifacts.mjs) | Record wasm sizes and SHA-256 in `docs/deployment/artifacts.json` (`npm run artifacts`) |
| [deploy.mjs](deploy.mjs) | Deploy a single coin, or the launchpad with `--launchpad`; `--lock` deletes contract keys; `--plan` prints a read-only mainnet cost plan |
| [deployment-plan.mjs](deployment-plan.mjs) | Pure helpers: cost plan, artifact pin checks, publish verification before lock |
| [mainnet-readiness.mjs](mainnet-readiness.mjs) | Read-only mainnet preflight (`npm run check:mainnet`) |
| [registry-admin.mjs](registry-admin.mjs) | Whitelist / remove / inspect agents in the test-only mock registry |
| [get-pass.mjs](get-pass.mjs), [demo-buy.mjs](demo-buy.mjs) | Developer helpers: fetch a pass, run a gated buy |
| [sandbox-e2e.mjs](sandbox-e2e.mjs) | Local-node rehearsal: buy → stake → sell → unstake → withdraw → harvest through every callback |

## Deploy safety

On `NEAR_NETWORK=mainnet`, `deploy.mjs` refuses to run unless all of these hold:

- the RPC identifies as mainnet;
- the target account does not exist yet (fresh deployment only);
- the pool is real (not `mock`), the registry requires TEE attestation, and there's no dev-key gate;
- `--lock` is passed;
- `CONFIRM_MAINNET=yes` is set;
- `MAINNET_COIN_CODE_SHA256` / `MAINNET_FACTORY_CODE_SHA256` match the built artifacts.

Before deleting the factory's keys it re-reads `get_config` and requires
`code_published` and the pinned hash to match. New keeper keys are written to a
private, git-ignored `.keeper-<network>-*.env` file, never printed.

Credentials go in a git-ignored `.env` (see [.env.example](.env.example)).
Walkthroughs: [testnet](../../docs/deployment/testnet.md) · [mainnet](../../docs/deployment/mainnet.md).

```bash
npm ci && node --test test/*.test.mjs
```
