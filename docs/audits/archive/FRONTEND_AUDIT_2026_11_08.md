# Frontend audit — 2026-11-08

Scope: cross-chain funding panel, EVM adapter, stored recovery state, and the
wallet-owned rNEAR staking panel. This is an internal engineering audit, not an
independent security certification. No funds were moved and no deployment was
performed by this audit task.

## Findings and fixes

### High — stale quote could survive a destination account change

The old UI cleared quotes in an effect. Between a changed account rendering and
that effect running, an older quote could remain in state while execution bound
its guard to the newly rendered account. The guard compared the current account
to itself, instead of the destination actually contained in the quote.

Fixed: compare the SDK quote's build context and normalized fields against the
latest rendered recipient, sender, source chain, token addresses and exact base
unit amount immediately before execution and again before each wallet signature.
The guard rejects a changed slippage setting, invalid freshness timestamps and
quotes older than 30 seconds. One stable idempotency key is retained per quote.

### High — ambiguous broadcast failures had no durable recovery barrier

Previously the panel persisted an order only after the SDK's submitted event.
A provider may broadcast successfully and then lose its response; reloading could
therefore offer another funding transaction without any record of the first.

Fixed: retain an awaiting-wallet attempt before entering the SDK and require
working browser storage before signing. Ambiguous errors become needs-review;
repeat submission stays disabled. A source transaction hash or delivery reference
is retained where available. An attempt without any identifiers can only be
cleared after the user explicitly confirms checking their source wallet and
finding no submitted funding transaction. Source submission never means delivery.

Limitations: local browser storage is not a transactional backend ledger and
cannot prevent a second device, a different browser, or deliberate storage
clearing from creating another order. RHEA idempotency behavior remains a service
guarantee, not a client-side guarantee. Recovery after an ambiguous broadcast with
no returned identifier still requires inspecting the source wallet. No funded
end-to-end order or browser-wallet rehearsal was performed.

### Medium — EVM account could change during network selection

The adapter originally checked accounts before requesting a chain switch. Wallet
UI can change accounts while that prompt is open.

Fixed: check accounts again after the switch, before asking for a transaction or
signature. EIP-712 domain chainId must match the selected source chain, in addition
to the normalized execution chain. Regression tests assert no send/sign request
occurs in these mismatch cases.

### Medium — restored order fields were insufficiently validated

Only recipient and status were checked. Persisted chain, sender, status values and
tracking references could be malformed and then enter polling or permanently
block the UI.

Fixed: validate the complete persisted order, enum values, supported source chain,
NEAR account syntax, EVM sender syntax, field types and lengths. Copy only accepted
fields. Reject oversized persisted state and oversized numeric input before BigInt.

### Medium — rNEAR builder/signing account race

The rNEAR SDK builds transactions asynchronously after the selected account is
captured. The old code handed the SDK the raw wallet sender, allowing a wallet
change during those reads to reach signing without a fresh check.

Fixed: wrap the SDK sender, then check the rendered account, wallet-selector
account, wallet-reported accounts and every transaction signer immediately before
signing. A synchronous operation lock prevents duplicate requests. Failed wallet
outcomes are surfaced; submission messages remain explicit about confirmation.
Refresh generations prevent older position reads from overwriting newer state.

### Low — loading and interaction clarity

Funding configuration now has an explicit checking state rather than initially
claiming it is unconfigured. Token discovery has a loading state. Select elements
have associated labels, and connect/quote/execute/tracking actions share a
synchronous operation guard to prevent duplicate clicks before React rerenders.

## Verification

`node --test webapp/test/frontend-funding.test.mjs` passes four focused tests:
quote binding/freshness, persisted recovery validation, account switching during
network selection, and typed-data domain mismatch. Existing cross-chain tests
also pass together with these tests. Production TypeScript/Vite build was run.
No real-wallet signing, quote fulfillment, bridge settlement, or real funds were
used. Browser-storage concurrency and service idempotency still need full
end-to-end testing before mainnet readiness can be asserted.
