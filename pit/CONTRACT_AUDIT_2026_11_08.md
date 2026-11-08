# Contract security review — 2026-11-08

Scope: current local `pit/contracts/pit` and `pit/contracts/factory`, including
seller payout accounting, pool callbacks and immutable launch configuration.
This internal code review is not an independent audit or a mainnet safety
certificate. No deployment or funded mainnet transaction was performed.
The Plamen orchestration and NEAR-specific reference files supplied in the chat
were unavailable in `~/.Codex/rules` / `~/.Codex/prompts`; the review used the
repository code and targeted host-side regression tests instead.

## Fixed: High — pool timeout allowed overlapping accounting operations

Previously `rebalance` allowed a second operation after 15 minutes, while old
pool receipts and callbacks could still execute. The callbacks do not carry an
operation ID, so late results could overwrite newer pool state, double count a deposit already included in a newer authoritative
pool view, or release a newer operation's lock.

The lock now fails closed: an unresolved pool operation cannot be superseded
by elapsed wall-clock time. Only its callback releases the lock. There is no
new manual unlock or timeout retry. Tests verify that the old timeout no longer
permits overlap, and a genuinely late successful callback still releases the
lock before another round-trip.

Residual limitation: a missing/failed callback can permanently lock rebalancing.
A future recovery mechanism must identify operations and reconcile receipts /
actual balances before releasing a lock. This change favors accounting safety
over pretending an uncertain transfer failed. State and callback ABI layouts
are unchanged by this particular fix.

## Fixed: Medium — wrong-account pool view accepted as reserve assets

`on_pool_state` previously accepted a serialized `PoolAccount` without checking
`account_id`. A buggy or misconfigured pool could return another customer's
position, creating fictional reserve assets and apparent harvestable surplus.
The callback now returns `PoolAccountMismatch`, releases its lock, and leaves
all balances unchanged. A regression test uses a large foreign position and
checks that none of it enters the reserve.

The pool remains an explicit trust dependency: a malicious configured pool can
still lie using the correct account ID. This check does not attest a validator
or establish correctness of the experimental RHEA adapter.

## Fixed: Medium — immutable factory curve configuration not prevalidated

Factory initialization accepted economics and duplicate pool entries which the
coin initializer rejects. Since factory defaults cannot be changed, a factory
could publish its global code successfully while every subsequent coin creation
failed. Initialization now checks unique pool IDs, minimum virtual reserves,
fee/buffer limits and increasing tiers beginning at zero, matching those coin
checks. Focused tests cover valid config, duplicates, excessive fee, too-small
buffer and a nonzero initial tier. These checks do not prove pool solvency or
validate the deployed code hash's business logic.

## Open: High — unresolved seller head limits the payout queue window

`process_queue` scans only IDs `[queue_head, queue_head + min(max, 10))`.
`queue_head` advances only when its ticket is removed by a successful callback.
If the oldest ticket's destination permanently rejects transfers, or its
callback is missing, the first nine later tickets can succeed but ID ten and
beyond are never visited. All further calls rescan the unresolved head and
removed IDs. A seller can make a named destination disappear after creating
its ticket; no administrator is needed to trigger the failure condition.

Persistent claims and the in-flight flag prevent silent loss and concurrent
duplicate sends, but they do not solve this liveness failure. Do not implement
blind timeout retries: an unknown callback outcome can correspond to an already
successful payment. The required design is bounded traversal independent of
one failed ticket, durable per-transfer resolution, and authorized recipient
recovery only after confirmed failure. Fair liquidity allocation and migration
of existing ticket layouts need explicit review.

## Open: High — non-seller transfers still have no durable recovery

`harvest` decrements reserve accounting and increases earned counters before
sending detached transfers to brain/creator. Agent-pass refunds, memory refunds
and factory refunds also have detached transfers. If the destination does not
exist or transfer execution fails, balances/counters may diverge and recipients
have no durable retry claim. Failed harvest transfer value remains physically
on the contract but outside its internal liquid accounting.

Use a common, storage-funded transfer state machine, with confirmed-failure
recovery and separate handling for unknown callbacks; reconcile harvested
counters only after the outcome is known. This requires a broader state design
than the narrow changes in this review.

## Open: Mainnet blockers and trust boundaries

- The RHEA reserve feature remains disabled by default. No RHEA storage
  registration / delayed withdrawal interoperability test was performed.
- Cached staking balances assume the configured pool's solvency and truthful
  responses. Staking principal can suffer validator/protocol loss; a surplus
  calculation with saturation does not restore lost principal.
- Payout gas budgets and balances must be tested with concurrent real receipts
  and deleted destination accounts, including callback gas exhaustion.
- The earlier ticket-format change requires migration for existing deployments
  containing tickets. Globally pinned code must be built and republished under
  its final audited hash; changing workspace source does not update live coins.

## Verification

- `cargo test --manifest-path pit/contracts/pit/Cargo.toml --features
  unit-tests,rnear-experimental --test unit`: **30 passed**.
- `cargo test --manifest-path pit/contracts/factory/Cargo.toml --features
  unit-tests --test config`: **5 passed**. The first build tried downloading the
  sandbox dependency and failed DNS; the successful retry explicitly used the
  already cached NEAR sandbox executable through NEAR_SANDBOX_BIN_PATH.
- Parent review is responsible for rebuilt WASM and aggregate integration checks.
  Host tests do not establish cross-contract receipt ordering or mainnet safety.
