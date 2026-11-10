# Web app

React 18 + TypeScript + Vite. Talks to the NEAR contracts directly from the
browser through a wallet (wallet-selector / MyNearWallet). A small Node server
serves the build and proxies RHEA cross-chain funding with a server-only key.

## Pages (hash routes)

| Route | What it does |
|---|---|
| `#/` | Launchpad: every coin with live stats, search, sort and filters |
| `#/launch` | Launch a coin: name, symbol, uploaded image (cropped and compressed to ≤ 16 KB on-chain) or emoji, early-access window, creator cut |
| `#/coin/<symbol>` | Trade: buy / sell, early-access pass flow, interactive bonding curve, reserve bar, the coin's mind (thoughts with in-browser verification, canon, memories) |
| `#/portfolio` | Holdings, sell value, coins you launched and your creator earnings |

Payout and refund recovery, and cross-chain funding via RHEA, live on the coin
and portfolio pages.

## Source layout

| Path | Purpose |
|---|---|
| [src/App.tsx](src/App.tsx) | Routing, home, launch and coin pages |
| [src/Trade.tsx](src/Trade.tsx) | Order ticket and the early-access pass flow |
| [src/Mind.tsx](src/Mind.tsx) | Thoughts, Proof-of-Thought verification against NEAR AI, canon, memories |
| [src/Curve.tsx](src/Curve.tsx), [src/Portfolio.tsx](src/Portfolio.tsx), [src/Payouts.tsx](src/Payouts.tsx) | Bonding-curve chart, positions, claim recovery |
| [src/CrossChainFunding.tsx](src/CrossChainFunding.tsx), [src/crossChain.ts](src/crossChain.ts) | RHEA funding UI and request/response validation |
| [src/chain.ts](src/chain.ts), [src/icon.ts](src/icon.ts), [src/ui.tsx](src/ui.tsx) | Chain types, data hooks, icon pipeline, shared components |
| [src/lib/near.ts](src/lib/near.ts) | Wallet, RPC views, transaction helpers |
| [server/rhea-proxy.mjs](server/rhea-proxy.mjs) | Allowlisted RHEA proxy: fixed routes, validated bodies, per-client limits |
| [serve.mjs](serve.mjs) | Static server with security headers and traversal protection |

## Configuration (build time unless noted)

| Variable | Meaning |
|---|---|
| `VITE_NEAR_NETWORK` | `testnet` (default) or `mainnet` |
| `VITE_PIT_FACTORY` / `VITE_PIT_CONTRACT` | Launchpad factory, or a single coin. Testnet defaults to `pit.pitdeployer.testnet` when neither is specified. Set `VITE_PIT_FACTORY=` and leave the coin empty for sample data. Mainnet requires an explicit factory or coin. |
| `VITE_PIT_BRAIN_URL`, `VITE_PIT_GATE_URL` | Brain feed API and launch gate |
| `VITE_NEAR_RPC`, `VITE_NEAR_AI_BASE` | Optional overrides |
| `RHEA_API_KEY` (server, runtime) | Enables cross-chain funding. Never use a `VITE_` name for secrets |
| `TRUST_PROXY` (server, runtime) | `1` behind Railway, for per-client rate limits |

## Run and test

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build && npm start
npm test           # proxy, funding and transaction-result tests
```
