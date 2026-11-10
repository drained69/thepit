# Backend audit — 2026-11-08

Scope: `pit/brain` and `pit/gate-agent`; local source review and regression tests.
This is an internal review, not an independent security certification. No live
transactions, deployments, inference requests or payments were performed.
The user-supplied Plamen references are unavailable at `~/.Codex/rules`; no NEAR
language-specific prompt was supplied by that workflow.

## Fixed

- **High, accounting correctness:** inference spending was only persisted at the
  end of a tick. A crash after a billable request could replay the unspent local
  budget on restart. Inference now persists a conservative byte-based budget
  reservation before the provider request and reconciles actual usage before
  publishing or recording a thought. An uncertain provider failure retains its
  reservation rather than assuming no billing occurred. This can conservatively
  understate available budget and requires operator reconciliation for ambiguous
  requests; it intentionally does not retry those charges automatically.
- **Medium:** direct ledger writes could leave partially written JSON, and all
  read errors silently created an empty state. The new ledger module validates
  state, fails closed on corrupt/unreadable existing files, writes a private
  temporary file, fsyncs, atomically replaces the ledger, and fsyncs its directory.
  Missing files alone initialize empty. `BRAIN_STATE_FILE` supports a mounted
  persistent-volume path. Its parent directory must already exist and be writable.
- **Medium, service availability:** HTTP calls to RPC, NEAR AI and Telegram could
  wait indefinitely and halt the serial keeper loop. They now have finite request
  timeouts. The evidence cache now has both count and byte limits (32 MiB total,
  2 MiB per cached blob), rather than a count limit alone. These limits bound
  retained evidence; upstream response buffering before cache insertion is still
  a separate resource limit to harden.
- **Medium, configuration safety:** invalid/negative/nonfinite ledger conversion
  and scheduling settings now fail startup rather than corrupting budget state.
- **Low:** gate epoch parsing coerced absent/blank inputs into epoch zero, and
  buyer validation accepted invalid NEAR separator combinations. Epoch strings
  now explicitly match 0–7 and account separators obey NEAR syntax. Verification
  also bounds session IDs and submitted field sizes before hashing.
- **Medium, production identity:** mainnet startup now refuses the development
  key identity and a Shade registry that does not require TEE attestation. This
  prevents a development configuration from presenting a mainnet gate as attested.

## Remaining material risks

1. The emoji challenge and hint remain machine-readable and Sybil-prone. Proof of
   work and session caps do not establish unique people or prevent paid solvers.
   Do not advertise this gate as bot-proof or proof of personhood.
2. An unauthenticated caller can acquire the three open sessions for a chosen
   buyer and deny that buyer new challenges until expiry. Per-client caps reduce
   abuse but do not authenticate account ownership. Fixing this needs a wallet
   ownership challenge protocol and compatible frontend changes.
3. The ledger is single-writer, local accounting. Production requires a persistent
   volume and one brain replica. Atomic files alone do not provide distributed
   locks, multi-replica transactions, exact-once posting or billing reconciliation.
   Restart without a volume loses credits and reservations; initialization starts
   at the current harvested counter to avoid recreating historical spending.
4. NEAR-to-USD conversion uses operator configuration; inference is paid by a
   separate provider API account. Local credits are not an on-chain payment system
   and do not prove harvested transfers actually reached the brain wallet.
5. `keyInReport` checks JSON key/report-data association and signatures, not full
   hardware quote verification, measurement policy, collateral and revocation.
   The current Proof-of-Thought flow must not be represented as a complete TDX
   verifier or proof that arbitrary published text matches a particular inference.
6. `TRUST_PROXY=1` relies on the deployment sanitizing forwarded headers. Raw
   client-controlled `x-forwarded-for` values cannot establish trusted identity.
7. Public proof blobs and the activity feed remain memory-only; evidence ages out
   and is lost across restart. Permanent evidence needs durable content-addressed
   storage and a retention/privacy policy.

## Verification

- `node --test pit/brain/test/ledger.test.mjs`: 5 passed. Tests cover private atomic
  replacement, corruption fail-closed, restart during a reservation, reconciliation,
  insufficient budget, and checkpoint failure preventing a reservation.
- `node --test pit/brain/test/rnear-sdk.test.mjs`: 2 passed.
- `node --test pit/brain/test/proof.test.mjs`: 6 passed against a local mock HTTP
  service (run with local-server permission).
- Gate regression suite: 15 tests including account/epoch validation, mainnet
  development identity rejection, one-shot passes, attempt limits, expiry and caps.
- `node --check pit/brain/index.mjs` and `proof.mjs` passed.

No claim is made about funded mainnet execution, real provider billing, public
load resistance, a fully verified hardware attestation chain, or cross-replica
budget safety. This work does not enable the RHEA reserve experiment.
