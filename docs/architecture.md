# Architecture and trust boundaries

The web app reads NEAR contracts directly. Its server forwards a narrowly
allowlisted set of RHEA API requests with a server-only credential. RHEA's SDK
builds and executes source-wallet funding requests and tracks destination orders.
NEAR wallet purchases remain a separate, explicit transaction after funding.

Each new coin pins its curve settings, validator pools and gate configuration.
Buys mint tokens; sells burn tokens and create caller-funded payout claims.
The keeper processes bounded rotating batches so one failed or unknown transfer
does not obstruct all later tickets. Confirmed failure permits owner-authorized
recipient recovery. Unknown callback outcomes remain locked; timeout retry could
pay twice. Active queue pagination is by current set index, not ticket ID.

The liquid reserve excludes refund storage, refund credits and reserved harvest
claims. The brain/creator earnings counters increase only on successful native
transfer callbacks. Refunds from asynchronous failed agent buys, memory storage
excess and storage management accrue as per-account credits, withdrawn separately.
This changes storage-management refund behavior; external token integrations
need an explicit interoperability review before broad DEX distribution.

Factory creation attempts retain an ID and a pending record. A failed child
creation retains 0.002 NEAR for refund-claim storage and returns the remainder
through a callback-confirmed claim. The creator can retry a confirmed failure.
Fresh deployments are required: old serialized state is not migrated by the
current deployment script or global code publication.

The brain meters confirmed on-chain harvests into locally configured inference
budgets. Budget is reserved durably before a possibly billable provider call.
The ledger requires persistent storage and a single writer; a stale process lock
requires manual reconciliation, not automatic deletion. It is not an on-chain
payment channel or proof of exact provider billing.

Validator pool behavior, RHEA's route execution, wallet software, RPC endpoints,
TEE registration and AI provider policy remain trust dependencies. Attestation
key/report association is not a complete hardware verification chain. The gate
challenge adds friction, but does not establish unique human identity or prevent
all bots. The experimental rNEAR reserve adapter remains disabled.
