# The Pit security follow-up

Historical review. Current findings and verification are in
[AUDIT_2026_11_08.md](AUDIT_2026_11_08.md).

This is an internal review of the current workspace, not an independent audit
or a guarantee of safety. The public Railway deployment was not changed.

## Open findings

### High: recovery remains incomplete for non-seller transfers

Seller payouts now use storage-funded persistent tickets for both immediate
and queued sells. A transfer marks the ticket in flight and reserves its NEAR;
a private callback deletes it on success or restores the reserve and retryable
liability on confirmed failure. Repeated keeper calls cannot dispatch a ticket
already in flight. The result status is `paying` until the callback succeeds.
All sells now require TICKET_DEPOSIT, including immediate payouts.

Tests cover failed transfers, retry, repeated keeper calls, repeated resolved
callbacks, out-of-order completion and solvency under random operations.
The normal WASM build passed all four existing NEAR sandbox integration tests.
These tests do not cover every account deletion or callback gas exhaustion case.
A missing callback deliberately leaves the ticket locked; blind timeout retries
could double pay. A permanently failing head ticket limits advancement of the
bounded queue window and needs an account-recovery design.

Agent-pass refunds, harvest payments and other detached transfers still need
recovery. Do not use this contract with real funds until these are resolved.
The ticket Borsh format changed: existing deployments with stored tickets need
a reviewed migration before upgrading. This workspace has not been deployed.

### Medium: gate challenge is not proof of personhood

The odd-one-out choices and hint are machine-readable. A client can request
new challenges and automate answers, and any client can exhaust a chosen
buyer's session allowance. The one-answer change prevents repeated guesses
within a solved session but does not prevent automation or Sybil accounts.

### Medium: brain budget is not a durable payment mechanism

The budget is local accounting based on a configured NEAR/USD estimate, while
inference is paid by a separate API account. A restart can lose credits or
in-flight spending history. New ledger entries now start at the current
harvest counter to avoid re-crediting historical harvests, but durable,
transactional accounting and reconciliation are still required.

### Medium: attestation provenance is not verified on-chain

The thought contract checks a signature under a caller-supplied key, not that
the key is NEAR AI's or that the posted text matches the response. Browser
checks can compare data and request a report; they do not verify a full TDX
quote. Treat TEE claims accordingly.

## Fixes in this review

- Wallet-selector action format and final outcome checks; stale quotes and
  storage registration state; clearer thought evidence labels.
- Agent pass expiry is checked again after the asynchronous registry call.
- Gate request validation and one answer per solved challenge in both gate
  implementations; fixed a challenge-generator overflow.
- New brain ledger entries no longer re-credit historical harvests; failures
  retrieving signatures after inference no longer discard usage information.
- Brain discovers factory coins in pages.

## Verification limits

The Pit contract unit suite and gate tests passed, as did the web production
build. The Rust gate, pass-script regression, and all six brain proof tests
passed. NEAR sandbox
integration, a live wallet transaction, a real TEE, rNEAR staking, and
end-to-end public deployment were not verified in this review. No claim of
complete coverage is made.
