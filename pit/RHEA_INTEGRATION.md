# RHEA integration plan for The Pit

Status: the local brain service uses `@rhea-finance/rnear-sdk` to expose a
read-only mainnet share price and APY at `/api/rnear/market`; the local web app
displays it. These changes have not been deployed. Cross-chain funding now has a local SDK-backed UI and same-origin server proxy.
A live transfer is not yet verified; RHEA credentials and a configured mainnet
Pit deployment are required. rNEAR staking of coin reserves remains experimental.

There is now a **research-only** `rnear-experimental` contract feature. It
queries `get_account_details` for the RHEA mainnet and testnet contract IDs
and avoids counting a newly staked deposit until RHEA reports the position.
It is disabled in normal builds. RHEA storage registration, complete payout recovery,
actual contract interoperability, asynchronous failure cases, and full
reserve invariants still require implementation and end-to-end verification;
this feature must not be deployed for real funds.

The rNEAR SDK is a liquid staking SDK, separate from RHEA's cross-chain swap
and lending SDKs. The Pit contract currently calls the NEAR validator-pool ABI;
the rNEAR share-token and delayed withdrawal flow require a different on-chain
adapter, accounting, and solvency review before they can back coin reserves.

## Product fit

The Pit already gives a coin its own bonding curve, a NEAR reserve, a gated
launch, and an AI brain funded by fees and staking rewards. The useful RHEA
addition is **fund a NEAR wallet from another chain, then buy in The Pit**.
This expands who can enter a launch without changing the coin's reserve math.

Do not route the coin's backing principal to RHEA lending. The existing
contract promises sellers that principal remains in its liquid buffer or
validator stake. Moving that backing to a lending protocol would change the
solvency, withdrawal, and queue guarantees and require a new contract review.

## Proposed user flow

1. Buyer connects a NEAR wallet and a source-chain wallet.
2. The app loads RHEA's live supported source and destination token lists.
3. Buyer chooses a source asset and amount. RHEA quotes a route to a NEAR
   asset the buyer can use to obtain native NEAR.
4. The app shows source spend, minimum destination amount, fees, route expiry,
   and expected arrival. Buyer confirms with the source wallet.
5. The app uses RHEA's order status to wait for **destination completion**,
   then checks the buyer's NEAR wallet balance. A source transaction alone is
   not proof that NEAR has arrived.
6. Buyer completes The Pit's human gate if the coin is in a gated epoch and
   sends the existing NEAR purchase transaction from that same NEAR wallet.

The funding transaction must end at the buyer's NEAR account. The Pit's gated
buy checks `predecessor_account_id` against the pass, and its current buy
methods take an attached native NEAR deposit. Sending a cross-chain deposit
straight to a coin contract would not match those conditions.

## SDK choice

RHEA currently publishes two distinct packages:

- `@rhea-finance/cross-chain-aggregation-dex` for quote, swap execution,
  wallet adapters, and order status. This matches the funding flow.
- `@rhea-finance/cross-chain-sdk` for cross-chain lending and Multi-chain
  Account operations. This is a separate lending integration; adding a market
  data widget alone should not be presented as a complete RHEA DeFi flow.

The sponsor announcement calls for the RHEA X Chain SDK. Confirm with the
RHEA sponsor whether the aggregation swap SDK qualifies for that prize before
claiming eligibility. The hackathon site permits projects in multiple tracks.

## Implementation gates

1. Deploy the factory and a coin on NEAR testnet, configure `VITE_PIT_FACTORY`,
   `VITE_PIT_GATE_URL`, `PIT_FACTORY`, keeper credentials, and NEAR AI access.
   This makes the existing local contract flow demonstrable on the public site.
2. Obtain RHEA API access from its Boss portal. Keep the credential on the
   server; do not put it in `VITE_*` variables or a browser bundle.
3. Build a server quote proxy with strict source/destination allowlists,
   amount limits, and rate limits. Use RHEA's SDK, not hand-assembled route or
   transaction payloads. Load token lists by direction and chain; do not infer
   token identity from symbols.
4. Add source-wallet adapters and an in-app funding panel. Bind destination to
   the signed-in NEAR account, show quote expiry and slippage, and make the
   funding step distinct from The Pit purchase.
5. Track an order through destination completion and verify the destination
   asset/balance before enabling the purchase step. Handle refunds, expired
   quotes, partial fills, and network mismatch.
6. Rehearse with small amounts. RHEA's published examples and chain coverage
   are for mainnets; a testnet route is not documented in the sources below.
   Do not claim a testnet cross-chain transfer until RHEA provides one.

## Current launch readiness

As of 2026-11-07, Railway `web` and `brain` services deploy successfully, and
`www.trythepit.xyz` has verified DNS and a valid certificate. The web service
does not have `VITE_PIT_FACTORY` or `VITE_PIT_CONTRACT`; it therefore runs in
preview mode with sample coins. The brain service does not have a coin/factory,
keeper, or NEAR AI key configured. The on-chain launch, gate, staking, and AI
loop are implemented in this repository, but they are not yet operating on the
public deployment. See [README.md](README.md) and [AUDIT_REPORT.md](../docs/audits/AUDIT_REPORT.md)
for code and security status.

## Sources

- RHEA sponsor announcement: <https://x.com/rhea_finance/status/2116243748816597134>
- RHEA aggregation SDK: <https://github.com/rhea-finance/crossChain-aggregation-sdk>
- RHEA lending SDK: <https://github.com/rhea-finance/cross-chain-sdk>
- RHEA swap API docs: <https://github.com/rhea-finance/rhea-sdk-docs/blob/main/CrossChainDexAPI.md>

## Local verification update

Seller payouts retain claims until transfer confirmation and can retry a
confirmed failure. All sells require the refundable ticket deposit. Unit tests
cover failure and callback ordering; the normal built WASM passes the four
existing NEAR sandbox integration tests. This does not validate the experimental
RHEA reserve adapter against RHEA itself. The adapter remains disabled by default;
no live RHEA reserve transaction or cross-chain transfer has been verified.
See AUDIT_2026_FOLLOWUP.md for remaining recovery and migration requirements.

## Cross-chain funding implementation (2026-11-08)

The web app now includes CrossChainFunding.tsx on home and coin pages, using
@rhea-finance/cross-chain-aggregation-dex for live directional token discovery,
quotes, swap execution, reporting and destination status. Injected EVM wallets
can fund from Base, Ethereum or Arbitrum to an explicitly native NEAR destination.
Quotes bind the connected NEAR account, expire after at most 30 seconds and use
0.5% slippage. The adapter checks source account and chain before signing.
Order identifiers are retained in local storage for delivery checks after reload.
A submitted source transaction is never displayed as destination completion.
After completion the UI queries the recipient NEAR balance independently.

The server proxy in webapp/server/rhea-proxy.mjs fixes the upstream origin,
allowlists API paths and route chains, limits requests and body size, and keeps
RHEA_API_KEY outside browser bundles. Configure that variable on Railway's web
service (not as VITE_*). Locally, export it before running Vite. RHEA issues the
credential at https://boss.rhea.finance. Production additionally requires
VITE_NEAR_NETWORK=mainnet and VITE_PIT_FACTORY or VITE_PIT_CONTRACT; do not point
these at unreviewed contracts merely to enable funding.

Verification: 8 proxy/amount/SDK discovery/wallet adapter tests and the web
production build pass. No live funded cross-chain order or browser-wallet
rehearsal has been completed. There is no testnet fallback or simulated success.
Cross-chain protocol fees, source gas and liquidity constraints still apply.
