# Factory and backend second pass — 2026-11-08

This internal follow-up covers the factory refund flow and production ledger
startup. It does not certify mainnet safety. No deployment or real-fund action
was performed. It supersedes the first service report's statement that the
brain lacks a process lock.

## Factory refund recovery implemented

The old factory discarded launch context and detached a NEAR transfer to the
creator. A failed transfer could silently lose its refund entitlement. The
factory now records a unique pending launch before its cross-contract call,
consumes it exactly once in the private creation callback, and creates a
persistent, fixed-recipient refund claim when needed. Each claim has an in-flight
flag. Success removes the claim; confirmed failure clears the flag for retry.
An unknown/missing callback never unlocks the transfer by timeout.

The initial refund chain is awaited, while the final return value still reports
whether coin creation succeeded. A later permissionless retry is dispatched only
to the creator saved in the claim. It cannot change the recipient. The claim is
still observable until confirmation. Creation callbacks use 40 Tgas, reserving
10 Tgas for refund resolution.

### Deliberate economic/API changes

- A failed asynchronous launch retains **0.002 NEAR** as a nonrefundable refund
  record storage fee. The rest is refunded. This fee is deducted from the existing
  creation deposit, not charged in addition. Synchronous validation failures still
  revert normally. Successful-launch excess refunds remain full; their record
  storage is funded by the existing 0.02 NEAR registry fee.
- This change must be disclosed in the launch UI and operator documentation.
  A mainnet rollout must not advertise a full asynchronous-failure refund.
- `on_coin_created` is a private callback taking `launch_id: U64`, with a
  `PromiseOrValue<bool>` result. It no longer accepts a full caller-carried record.
- New methods: `get_refund({launch_id})`,
  `retry_refund({launch_id})`, and `get_launch_status({launch_id})`.
  `retry_refund` returns dispatch status, not confirmed payment.
- New events `launch_started` and `refund_created` include the launch ID.
- New persistent fields and Borsh types require a migration review for existing
  factories. Do not overwrite a factory with this layout as an unreviewed upgrade.

The fixed refund fee covers the measured storage footprint even for a 64-byte
recipient and maximum U128 amount. A failed recipient cannot accumulate records
using the factory's own storage float: each asynchronous failure leaves its own
storage fee behind.

### Remaining factory limits

A deleted creator account cannot authorize a new destination. Recovery requires
restoring that account or a separate, reviewed recovery identity design. A lost
creation/refund callback deliberately leaves a pending state for investigation;
blind retries could double pay. Global-code publication's excess deposits are
not covered by this refund workflow; callers should attach its exact quoted burn
amount. Immutable pinned code still needs review before real-fund publication.

## Single-writer ledger startup implemented

The brain now opens `<BRAIN_STATE_FILE>.lock` exclusively before keeper/AI setup
or state loading. A second writer fails startup. Graceful exit releases the owned
lock. Unknown/stale locks are never automatically reclaimed because another
replica could still be spending.

For an active mainnet brain, startup now requires:

```
BRAIN_STATE_FILE=/data/brain-state.json
BRAIN_PERSISTENT_STORAGE_CONFIRMED=yes
```

The path must be absolute, its directory must exist, and it must refer to a real
persistent mount. The confirmation is an operator assertion, not automatic
verification of provider storage guarantees. Run **one brain replica**. Deployment
must stop the old writer before starting its replacement on the same ledger.
After an unclean exit, stop all replicas, verify no writer remains, then remove
the abandoned `.lock` file manually before restarting. Never delete a live lock.
The service keeps all reservations after uncertain inference outcomes; operators
must reconcile provider usage rather than resetting the ledger to regain credit.

The gate's mainnet registry TEE requirement is now checked before account funding
or registration. No client gate protocol or signing ABI was changed in this pass.
The machine-readable challenge and account-targeted session denial remain open.

## Regression evidence

- Factory unit/config tests: **9 passed**. Includes failed refund, repeated calls,
  retry, successful excess refund, exact-cost success, immutable configuration,
  launch status and measured maximum-account storage footprint.
- Factory WASM built successfully.
- Factory NEAR sandbox integration: **1 passed**, including normal launch/trade,
  overpayment refund, and a real asynchronous create failure forced by a preexisting
  child account. Balance assertions allow five sandbox blocks for gas-refund
  receipts to settle; original tight refund tolerance is retained.
- Ledger tests: **7 passed**. Covers private atomic files, corruption, reservation
  restart, invalid costs, failed checkpoint, exclusive lock and persistence config.
- Combined ledger/rNEAR SDK/gate suite: **24 passed**.
- Dry simulation with an explicit temporary state path completed one tick and
  released its process lock without inference or chain calls.

No funded cross-chain flow, real inference billing, distributed filesystem lock
semantics, SIGKILL recovery automation, complete TDX verification, or production
load test is claimed.
