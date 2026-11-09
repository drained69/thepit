# Launch gate — early-access passes as a NEAR Shade Agent

Issues the short-lived, wallet-bound passes a coin requires during its
early-access window. In production it runs as a **NEAR Shade Agent** inside a TEE
(Phala Cloud / dstack): its signing key is born in the enclave, and the coin
contract accepts a pass only while the agent registry reports that key's agent as
`Valid`.

## Flow

```text
GET  /api/gate/challenge?buyer=&epoch=&sale=
      1. buyer wallet must exist and hold GATE_MIN_BALANCE_NEAR   → 403 otherwise
      2. per-client and per-buyer open-session caps                → 429 / 503
      3. returns: odd-one-out challenge + proof-of-work nonce/target

POST /api/gate/verify {session_id, pow_solution, answer}
      one attempt per solved proof; a wrong answer burns the session
      returns: pass JSON + Ed25519 signature + agent_id
```

The pass binds `{v, sale, kind, buyer, epoch, max_amount, nonce, expires_at_ms}`.
The coin contract verifies the signature over those exact bytes, then checks the
buyer, sale, epoch, expiry, cap and one-use nullifier.

**What it does and doesn't prove.** A script can solve the challenge. What
limits bots is the per-wallet cap plus the wallet balance floor, so every extra
bot wallet costs capital. It does not prove a unique person.

## Identity modes

| `GATE_IDENTITY` | Key | Use |
|---|---|---|
| `shade` | Generated in the TEE; registers with a TDX attestation the agent contract verifies | Production |
| `dev-key` | A local Ed25519 key as an implicit account; whitelisted in the mock registry | Local and testnet only; refused on mainnet |

## Files

| File | Purpose |
|---|---|
| [src/server.mjs](src/server.mjs) | Entry point: loads identity, wires eligibility and HTTP |
| [src/http.mjs](src/http.mjs) | Request handling; malformed input gets 4xx, never a crash |
| [src/gate.mjs](src/gate.mjs) | Challenge, proof of work, session limits, pass signing (no I/O) |
| [src/eligibility.mjs](src/eligibility.mjs) | Wallet existence and balance floor, cached and concurrency-bounded |
| [src/identity.mjs](src/identity.mjs), [src/keys.mjs](src/keys.mjs) | Shade or dev-key signer |
| `Dockerfile`, `docker-compose.yaml`, `deployment.yaml` | Shade Agent / Phala deployment |

## Configuration

| Variable | Meaning |
|---|---|
| `GATE_IDENTITY` | `shade` or `dev-key` |
| `AGENT_CONTRACT_ID` | The agent registry (Shade contract, or the mock on testnet) |
| `SPONSOR_ACCOUNT_ID`, `SPONSOR_PRIVATE_KEY` | Funds the agent's implicit account |
| `GATE_DEV_SECRET` / `GATE_DEV_KEY_FILE` | dev-key mode: pin the key across restarts |
| `GATE_MIN_BALANCE_NEAR` | Buyer wallet floor (default `1` on mainnet, `0` elsewhere = must exist) |
| `TRUST_PROXY` | `1` behind a proxy: use the proxy-appended `X-Forwarded-For` hop |
| `NEAR_NETWORK`, `NEAR_RPC`, `PORT`, `SALE_ID`, `VERIFIER_NAME` | Network and service settings |

## Run and test

```bash
npm ci
GATE_IDENTITY=dev-key NEAR_NETWORK=testnet AGENT_CONTRACT_ID=registry.you.testnet SPONSOR_ACCOUNT_ID=you.testnet SPONSOR_PRIVATE_KEY=ed25519:... npm start
npm test
```

Production deployment with `shade deploy`: see
[Run the Shade Agent gate](../README.md#run-the-shade-agent-gate).
