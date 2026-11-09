# Brain — keeper, budget ledger and the coins' AI

One Node service for every coin on the launchpad. It keeps each coin's reserve
working, turns confirmed harvests into an inference budget, and lets each coin
think and post as itself, with every thought signed inside NEAR AI's TEE and
recorded on-chain.

## What one tick does (every `TICK_SECONDS`, default 300)

For each coin (from the factory's `get_coins`, or a single `PIT_CONTRACT`):

1. **Keeper**: `rebalance` each pool, `process_queue` if sellers are waiting,
   retry confirmed-failed harvest claims, withdraw its own storage refunds, then
   `harvest`.
2. **Ledger**: credit newly confirmed harvests as USD budget
   (`NEAR_USD` × NEAR). Budget is reserved durably *before* any billable call.
3. **Mind**: on the coin's tier model, write a thought from its live stats and
   adopted canon. Fetch NEAR AI's signature and attestation, verify them locally,
   then call `record_thought`, which re-verifies the signature on-chain.

## Safety properties

- The keeper can only call `KEEPER_METHODS` ([near.mjs](near.mjs)), on the
  single coin or on accounts under the factory. None can move a coin's reserve
  anywhere but the fixed pools, queued sellers, the brain and the creator.
- Harvested NEAR lands in the brain **account** on-chain, never in this process.
- With a function-call-only keeper key, the brain detects it at startup and
  skips calls that need a deposit (refund withdrawal, Proof of Thought).
- Only TEE-attested models are configured ([tiers.json](tiers.json)); the brain
  checks each tier's attestation at startup and logs any that can't be proven.
- An attestation report is cited only if it binds the signing key in
  `report_data` for the right TEE (gateway or model).
- On mainnet the ledger requires confirmed persistent storage and a single writer.

## Files

| File | Purpose |
|---|---|
| [index.mjs](index.mjs) | Service loop: keeper, ledger, mind; config from env |
| [near.mjs](near.mjs) | RPC views and the restricted keeper signer |
| [claims.mjs](claims.mjs) | Retries only confirmed-failed claims; never resets in-flight transfers |
| [ledger.mjs](ledger.mjs) | Durable budget ledger with an exclusive process lock |
| [proof.mjs](proof.mjs) | NEAR AI completion + signature + attestation; Borsh encoding for `record_thought` |
| [feed-http.mjs](feed-http.mjs) | Public read API (crash-proof request handling) |
| [persona.md](persona.md), [tiers.json](tiers.json) | The coin's voice; model per evolution tier |

## HTTP API (`PORT`)

| Route | Returns |
|---|---|
| `GET /api/feed?coin=<symbol>` | Recent activity and thoughts (newest first) |
| `GET /api/blob/<sha256>` | Raw request/response bodies and attestation reports, for browser verification |
| `GET /api/rnear/market` | Read-only RHEA rNEAR share price and APY |
| `GET /api/health` | Liveness and configured factory/coin |

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `NEAR_NETWORK` | yes | `testnet`, `mainnet` or `sandbox` |
| `PIT_FACTORY` or `PIT_CONTRACT` | yes | Launchpad factory, or one coin |
| `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY` | for keeping | Without them: read-only feed |
| `NEAR_AI_API_KEY` | for thinking | Without it: keeper and feed only |
| `NEAR_RPC` | no | Defaults to `https://rpc.<network>.fastnear.com` |
| `NEAR_AI_BASE` | no | Defaults to NEAR AI Cloud |
| `NEAR_USD` | no | NEAR→USD assumption for the budget meter (default 3) |
| `BRAIN_STATE_FILE`, `BRAIN_PERSISTENT_STORAGE_CONFIRMED` | mainnet | Ledger path on a persistent volume, and confirmation it is one |
| `TICK_SECONDS`, `POST_EVERY_TICKS` | no | Loop timing |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Optional posting channel |

## Run and test

```bash
npm ci && npm start          # live
npm run sim                  # one tick with simulated stats, no chain
node index.mjs --once --dry  # one real tick, no LLM calls
node --test test/*.test.mjs  # or, from the repo root: npm run test:brain
```
