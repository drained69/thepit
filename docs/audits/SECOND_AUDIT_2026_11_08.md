# Second audit and release preparation — 2026-11-08

**Status: source fixes implemented; public mainnet release still requires the
external readiness gates in the deployment guide.** No funded mainnet transaction
or immutable contract deployment was performed. This is an internal audit pass,
not an independent certification or proof that no bugs remain.

## Previously open High findings addressed

1. **Seller queue obstruction:** active tickets now use an indexed set and a
   bounded rotating cursor. One failed or unknown-outcome oldest claim cannot
   trap every ticket after the first ten IDs. Completion removal is constant-time;
   no callback scans an unbounded history of removed IDs. Pagination is now by
   active-set index, which can reorder. Strict FIFO is not promised.
2. **Seller destination recovery:** the original owner can change a recipient
   only after a confirmed transfer failure and with a full-access 1-yocto action.
   Pending/unknown outcomes remain locked to prevent duplicate payment.
3. **Harvest recovery/accounting:** bounded brain/creator claims reserve funds
   exactly once; retries do not debit reserves again. Earnings counters and harvest
   events reflect confirmed transfer success. Failed claims remain recoverable.
4. **Other Pit native refunds:** asynchronous agent-buy failures, memory refunds,
   excess storage deposits and token unregister refunds accrue into caller-funded
   persistent credit records with callback-confirmed withdrawals. Tiny refunds
   aggregate without allocating unbounded records. Receiver recovery requires the
   owner and a confirmed failure. Actual maximum-ID storage funding is tested.
5. **Factory refunds:** a durable launch ID/reservation precedes child creation.
   Refund claims survive failed native transfers; the initial return chain awaits
   refund resolution while preserving the creation result. Failed asynchronous
   launches retain **0.002 NEAR** for refund-claim storage. Successful overpayment
   refunds remain full. Unknown callbacks are not retried by timeout.
6. **Brain single-writer safety:** an exclusive process lock prevents overlapping
   local writers. Mainnet startup requires an absolute state path and explicit
   persistent-storage confirmation; uncertain stale locks require manual review.
   The keeper retries confirmed harvest failures and withdraws its storage credits.

## Additional fixes from this pass

- Source-wallet funding separates approvals from actual funding submissions.
  A quote expiring while approval confirmation is pending does not resend funding.
  Existing ERC20 allowance avoids unnecessary repeat approval transactions.
- Recovery records retain build/order/router/report context before signing, retry
  reporting when appropriate and distinguish a built order from a submitted source
  transaction. Same-browser Web Locks and storage updates exclude concurrent tabs.
- Quote/build identities and reviewed minimum output are checked again after a
  slow network switch, immediately before signing. Unmount cancels unfinished
  SDK activity without claiming that an already broadcast transaction was reverted.
- rNEAR outcomes inspect child receipt failures and query final outcomes when
  hashes are available. Optimistic execution is not represented as finality.
- Gate buyer quotas are scoped to client, sale and epoch; an unrelated client
  cannot exhaust a globally shared quota for a chosen victim. Global and per-client
  capacity bounds remain. IP identity and these quotas are not proof of ownership
  or personhood, and shared/proxied clients still need a trusted edge policy.
- Trading preregisters agent-buy refund storage separately so its purchase quote
  matches the deposit reaching the curve. Sell collateral is now **0.004 NEAR**.
  Refund and ticket recovery panels expose the new claims instead of asserting
  every failed payment has already returned to the wallet.
- Launch success checks the actual returned boolean and the recorded creator.
  Launch IDs are decoded from factory events for refund recovery. Transaction
  signing explicitly binds the expected signer and preserves unknown-outcome
  warnings rather than automatically resending.
- Storage funding rounds up correctly at cent boundaries. A read-only deployment
  plan hashes final artifacts. Funded mainnet deployment requires matching reviewed
  coin/factory SHA-256 pins, verified network identity, validator interface and TEE
  registry policy, and refuses an already-existing target.
- Newly generated keeper secrets are written privately before the key/account
  transaction, rather than printed or saved only after irreversible steps.
- Added a read-only mainnet readiness command, root task scripts, pinned Rust
  toolchain, architecture/deployment docs, audit archive and service upload ignores.
  Primary product services retain independent lockfiles and Railway build roots.

## Verification

- Full revised Pit host suite: **91 passed**, including randomized operations and
  seven recovery regressions. One additional maximum-length gated-buy storage
  regression passed separately (the existing 19-test launch suite becomes 20).
- Maximum-length refund/ticket collateral and gated nullifier/token-account storage
  are caller-funded under the tested NEAR storage cost.
- Normal WASM builds passed with experimental rNEAR disabled.
- Existing Pit sandbox suites passed (**4**); an additional actual-receipt failure
  test passed (**1**): a nonexistent brain and a deleted seller cause native transfer
  failure, preserve claims, and settle after destination restoration/recovery.
- Revised factory unit/config tests: **9 passed**; final factory sandbox launch,
  overpayment and failed-child recovery test: **1 passed**.
- Combined Node/TypeScript suites passed (**64**) before the final gate quota
  regression, which passes separately with the gate suite. New checks include
  deployment pins/rounding, read-only network checks, transaction result decoding,
  claims maintenance, source approval expiry and partial receipt failure.
- Production TypeScript/Vite build passed. Six Moderate legacy wallet/NEAR API
  dependency advisories remain as described in the first audit; no forced unsafe
  dependency migration was applied.

## Important interface and release boundaries

- **Fresh deployment only.** Both contract state and private callback ABIs changed.
  There is no reviewed migration for previously deployed state. New global code
  publication does not update old immutable coins.
- Pit storage-management overpayments/unregister refunds now become credits, with
  storage registration requirements. This differs from immediate NEP-145 refund
  semantics. External token/DEX compatibility requires review before listing.
- Native rNEAR reserve use remains experimental and disabled. RHEA token metadata
  and order status do not prove that native NEAR was actually unwrapped/delivered.
  A small controlled funded rehearsal must establish that before public funding.
- Validator truth/solvency, TEE measurement/collateral verification, AI provider
  billing and wallet software remain external dependencies. The challenge does not
  prove unique humans or exclude all bots. Do not market it as bot-proof.
- A truly missing callback intentionally leaves its claim/pool lock unresolved.
  Recovery needs verified receipt reconciliation; automatic timeout resending is
  unsafe. Local files and locks do not supply distributed payment correctness.
- Public APIs still need deployment-level abuse monitoring. Cross-device/browser
  funding deduplication cannot be enforced by browser-local state alone.

## Mainnet check for the supplied public account

A read-only RPC check confirmed `drained99.near` exists, has **0 NEAR**, and
`pit.drained99.near` does not exist. No validator pool or production agent registry
was provided. The parent must be funded and those dependencies verified before
using the reviewed signing workflow. No private key was requested or used.

See [mainnet deployment guide](../deployment/mainnet.md) and
[artifact manifest](../deployment/artifacts.json). Railway application deployment
is separate from the future NEAR mainnet signing step.

## Railway application release

The production Railway web and brain deployments both reported `SUCCESS`:

- Web: `21f3972c-a0b5-4b8d-9582-592a3ddb3076`.
- Brain: `d0087370-aae8-4262-9db4-610138ce8e14`.

The public web health endpoint returned HTTP 200 and cross-chain configuration
reported enabled source chains Ethereum, Base and Arbitrum, with NEAR as the
destination. The release check also observed working source/destination token
lists and rejection of malformed quotes and foreign-origin submissions.
These checks do not prove funded settlement. A subsequent attempt to download
the full JavaScript bundle timed out; it is not recorded as a successful check.

The brain health response reports no configured factory or coin. This release
therefore remains an **application preview**. Contract-only payout controls are
excluded from preview builds. No mainnet contract deployment, native delivery
rehearsal or production TEE verification is implied by Railway deployment.

Public deployment identifiers and release boundaries are recorded in
[release.json](../deployment/release.json).
