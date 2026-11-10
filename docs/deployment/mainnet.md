# Mainnet deployment walkthrough — drained99.near

> **Status: deferred.** The hackathon build runs on NEAR testnet
> ([testnet runbook](testnet.md)). Mainnet launch waits for an independent
> third-party audit of `pit/contracts/pit` and `pit/contracts/factory`. This guide
> is ready for that moment; nothing here has been executed on mainnet.

## Current state and boundary

The read-only check on 2026-11-08 found `drained99.near` exists with **0 NEAR**
and `pit.drained99.near` does not exist. A validator pool and production Shade
Agent registry have not been supplied. No key ownership, funded mainnet transfer,
production TEE policy or RHEA native unwrap has been verified.

The web and brain were deployed to Railway as a preview on 2026-11-08; see the
[application release record](release.json). The live brain has no factory or coin
configured. Railway deployment does not create NEAR contracts. This guide contains future
signing steps; it is not evidence that a mainnet launch has happened.

Use **fresh contracts**. This revision changes Pit/factory state layouts, private
callback arguments, refund behavior and claim scheduling. Neither `deploy.mjs`
nor publishing a new global artifact migrates an existing factory or coin.

## 1. Resolve release dependencies

Before accepting public funds:

1. Select and inspect a real mainnet validator pool supporting `get_account`,
   `deposit_and_stake`, `unstake`, `withdraw`. Validator/protocol loss remains a
   backing risk; testnet mocks and the experimental rNEAR adapter are forbidden.
2. Deploy/verify the production Shade registry and gate using the process in
   `pit/gate-agent/`. Its `get_contract_info` must report `requires_tee: true`.
   Review the agent measurement, signing identity, report verification and
   expiration policy; a flag alone does not establish a complete TDX trust chain.
3. Verify trusted edge/client identification and choose a real personhood/anti-Sybil
   policy before advertising personhood-based access. Buyer quotas are now scoped
   to client, sale and epoch, but IP identity is not wallet ownership.
   The current challenge does not prove unique people or exclude every bot.
4. Review the token's changed storage-management behavior: overpayments and
   unregister refunds accrue as credits instead of standard immediate transfers.
   External NEP-145/DEX integrations need compatibility tests before listing.
5. Rehearse a small RHEA transfer to a controlled mainnet wallet and verify an
   increase in *native spendable NEAR*, not only RHEA's status or a `wrap.near`
   balance. Review the returned route, fees, minimum output and source approval.
6. Review all fresh-deployment contracts and the final artifact hashes. Resolve
   any unknown callback locks by verified receipt reconciliation; never unlock
   or resend a transfer merely because a timeout elapsed.

The unresolved items above are release gates, not items the deploy script can
prove automatically. The audit does not certify safe public operation.

## 2. Install and verify locally

Use Node 20.11+ and the Rust/cargo-near toolchain used for the successful builds.
Keep `Cargo.lock` and service `package-lock.json` files. Run `npm ci` inside
`webapp`, `pit/brain`, `pit/gate-agent` and `pit/scripts`.

```sh
npm run build:web
npm run test:web
npm run test:brain
npm run test:gate
npm run test:scripts
npm run build:contracts
```

Run the contract host and local sandbox suites documented in their test files.
The sandbox pool and registry are fixtures, not valid production dependencies.
Normal WASM builds must leave `rnear-experimental` and `unit-tests` disabled.

## 3. Prepare public configuration and a read-only plan

The intended addresses are:

| Role | Account |
|---|---|
| Parent used for setup | `drained99.near` |
| Immutable factory | `pit.drained99.near` |
| Brain receipt account, default | `brain.drained99.near` |
| Keeper/gas account | `keeper.drained99.near` |
| New coin example | `symbol.pit.drained99.near` |

Set the public inputs locally after selecting real dependencies:

```sh
export NEAR_NETWORK=mainnet
export DEPLOYER_ID=drained99.near
export POOL='REPLACE_WITH_VERIFIED_POOL.poolv1.near'
export AGENT_REGISTRY='REPLACE_WITH_PRODUCTION_REGISTRY.near'
```

The uppercase placeholders are intentionally invalid; do not leave them in place.
The deployment key is not needed for either read-only command:

```sh
npm run check:mainnet
node pit/scripts/deploy.mjs --launchpad --plan
```

The plan prints the exact local SHA-256 hashes and estimated native NEAR storage
and global publication requirements. With the 321,756-byte coin artifact from
this review, publication alone is approximately **32.1756 NEAR** at the contract's
current cost formula. Factory funding (~3.04), keeper (1) and default brain (0.05)
bring that illustrative subtotal to ~36.27 NEAR, **before gas, gate costs and
operating funds**. Rebuild changes this number: run `npm run artifacts` to refresh `artifacts.json`, and use the final plan and current
protocol configuration. Global code publication burns funds; storage deposits
and withdrawable balances are different costs.

Fund the parent only after reviewing the release gates, budget and signing setup.
The preflight checks RPC network identity, account existence and available funds;
it does not demonstrate that you control `drained99.near`.

## 4. Review and sign the fresh deployment locally

Do not send private keys through chat, screenshots or public variables. The
current script uses a local `DEPLOYER_PRIVATE_KEY` and does not support a hardware
wallet signing adapter. Use a controlled local signing environment and understand
its access to the parent account. A private ignored `pit/scripts/.env` may be
used with filesystem mode 0600; never commit or upload it.

Copy the **reviewed final hashes** from the plan into local variables:

```sh
export MAINNET_COIN_CODE_SHA256='REPLACE_WITH_REVIEWED_COIN_SHA256'
export MAINNET_FACTORY_CODE_SHA256='REPLACE_WITH_REVIEWED_FACTORY_SHA256'
export CONFIRM_MAINNET=yes
# Supply DEPLOYER_PRIVATE_KEY privately in this local process, not in this guide.
node pit/scripts/deploy.mjs --launchpad --lock
```

**Do not run this signing command until step 1 is resolved.** The script rejects
mock pools, a development gate, mismatched artifact pins, non-mainnet RPC,
registries not requiring TEE and an existing target. It does not resume partial
mainnet deployment. A partial failure requires inspection before further actions.

`--lock` deletes the factory's access keys after initialization/publication.
This is irreversible: the factory cannot be upgraded and new coins inherit
immutable pinned code. Review configurations before signing, not after key deletion.
The parent, keeper and brain receipt accounts are separate from the locked factory.

New keeper credentials are written to an ignored `.keeper-mainnet-*.env` file
with mode 0600 **before** the corresponding key/account transaction. They are
not printed. Store the keeper secret in Railway's brain service; do not use the
parent's full-access key as a service credential.

## 5. Configure Railway services

### Web

| Variable | Value |
|---|---|
| `VITE_NEAR_NETWORK` | `mainnet` |
| `VITE_PIT_FACTORY` | Verified deployed `pit.drained99.near` |
| `VITE_NEAR_RPC` | Your verified mainnet RPC |
| `VITE_PIT_BRAIN_URL` | Public brain-service base URL |
| `VITE_PIT_GATE_URL` | Production gate URL |
| `RHEA_API_KEY` | Server-only RHEA credential |
| `TRUST_PROXY` | `1` behind Railway, so funding rate limits are per client (uses the proxy-appended `X-Forwarded-For` hop) |

Never give a secret a `VITE_*` name. The RHEA credential previously shared in
chat should be rotated before public launch. Native token-list metadata is
informational; it does not replace the funded delivery rehearsal.

### Gate

| Variable | Value |
|---|---|
| `GATE_MIN_BALANCE_NEAR` | NEAR a buyer wallet must hold before it can request a pass (default `1` on mainnet; `0` = must exist only) |
| `TRUST_PROXY` | `1` behind a reverse proxy, so per-client limits use the proxy-appended address |

The gate makes each additional bot wallet cost capital and a solved challenge.
It does not prove a unique person; describe gated windows as early access, not as verified-people-only access.

### Brain

Attach a **persistent volume**, for example mounted at `/data`, and run **one
replica**. Stop the old writer before starting another one.

| Variable | Value |
|---|---|
| `NEAR_NETWORK` | `mainnet` |
| `NEAR_RPC` | Verified mainnet RPC |
| `PIT_FACTORY` | `pit.drained99.near` |
| `KEEPER_ACCOUNT_ID` | `keeper.drained99.near` |
| `KEEPER_PRIVATE_KEY` | Generated keeper secret |
| `BRAIN_STATE_FILE` | `/data/state.json` |
| `BRAIN_PERSISTENT_STORAGE_CONFIRMED` | `yes`, only after verifying the real mount |
| `NEAR_AI_API_KEY` | Private provider credential, if enabling inference |
| `NEAR_USD` | Reviewed conversion assumption for the local budget meter |

The process refuses an unconfirmed persistent-storage configuration on mainnet.
Atomic ledger and process locks do not provide multi-replica/distributed safety
or exact provider billing. A stale lock after SIGKILL must be reconciled manually
with every writer stopped. Never delete a lock to bypass an unknown live writer.
The factory keeper must retain gas funds for thought storage and refund withdrawals.

Deploy from the repository root after verifying the configuration:

```sh
railway up webapp --path-as-root --service web --detach
railway up pit/brain --path-as-root --service brain --detach
```

## 6. Verify before opening a public launch

- Read factory config: correct final hash, code published, correct brain, thinker,
  pool and registry. Confirm the factory has zero access keys.
- Check the actual gate identity, expiry and registry policy.
- Verify web `/healthz`, brain `/api/health`, and funding `/api/cross-chain/config`.
  A healthy endpoint or enabled flag does not prove a functioning launch.
- With small controlled funds, launch a coin, verify its creator/address, buy,
  sell, observe claim settlement, and test gated expiry/cap rejection.
- Observe a stake/unstake/withdraw round trip and confirmed harvest. Unstaking
  follows pool epoch rules; do not promise a fixed wall-clock duration.
- Verify confirmed harvest funds reach the brain account before metering credits.
  Check persistence and exclusive-writer behavior across a controlled restart.
- Verify a real cross-chain native NEAR delivery and a subsequent separate buy.
- Export the final hashes, public transaction IDs, costs and verification results.
  Do not describe untested flows as live or all users as verified people.

## Recovery reference

- Every sell now attaches **0.004 NEAR**, returned with its successful payout.
  `get_ticket(ticket_id)` reads one claim. Queue list pagination uses active-set
  indices and may reorder as claims settle. It is not strict FIFO.
- A first agent purchase preregisters refund storage using the queried
  `refund_registration_deposit()` (currently 0.004 NEAR maximum deposit).
  Actual storage stays retained; the excess becomes withdrawable credit.
- Read `get_refund_credit(account_id)` and call `withdraw_refund()` with 1 yocto
  after an unsuccessful agent buy or other credited refund. Recipient recovery
  is owner-authorized only after confirmed failure.
- `retry_harvest(creator)` does not debit reserves again. Earnings count only
  confirmed successful transfers. Missing callbacks remain locked.
- Factory `launch_started` logs expose `launch_id`. Read `get_launch_status` and
  `get_refund`; retry confirmed failures with `retry_refund`. A failed asynchronous
  creation retains **0.002 NEAR**. A pending callback must not be blindly retried.

Sources: [NEAR CLI account/key and deployment guide](https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md),
[NEAR staking pool interface/reference](https://github.com/near/core-contracts/tree/master/staking-pool),
[RHEA SDK](https://github.com/rhea-finance/crossChain-aggregation-sdk).
