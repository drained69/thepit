# $HUMAN — a pass-gated token launch prototype

> Earlier prototype, kept for reference. The current project and hackathon
> submission is **The Pit**: see [README.md](../../README.md) and [docs/SUBMISSION.md](../../docs/SUBMISSION.md).

> **Early token allocation is gated by short-lived, wallet-bound passes. The
> NEAR contract verifies a registered Ed25519 signature and enforces the sale
> rules on-chain. The default demo uses simulated attestation, not a production
> TEE, and a challenge does not prove unique personhood.**

NEAR Hackathon · Track: **Memecoins with Mechanics**

---

## What this prototype does

$HUMAN is a NEP-141 token sale where a buyer needs a short-lived pass during
the human allocation epochs. The pass binds the buyer account, epoch, amount
cap, expiry, and one-use nonce. The contract checks its signature against an
owner-registered verifier key and settles the purchase on NEAR:

```
                                  ┌──────────────────────────────┐
 browser (anyone)                 │        tee-gate (axum)       │                     NEAR chain
 ─────────────────                │      (local demo process)    │                     ──────────
  odd-one-out challenge ─────────▶│  gateway + policy checker    │
  browser PoW (sha256) ──────────▶│  checked by ordinary process │──▶ pass {buyer, epoch,
  simulated evidence ────────────▶│  demo-only simulated quote   │      max_amount, nonce,
                                  │  demo signing key            │      expiry} + Ed25519 sig
                                  └──────────────────────────────┘                                 │
                                                                                                   ▼
                                                    owner registers the KEY (+ evidence hash)
                                                    `purchase(pass, sig_b64)` verifies the sig
                                                    with `env::ed25519_verify` → mints → burns
                                                    the sha256(pass) nullifier (one-shot)
```

The default demo uses a self-signed simulated quote to illustrate the evidence
flow. The browser inspector validates that simulated signature and payload
structure. It does not validate real Intel TDX quotes or prove that the gate
runs in a TEE. Real TEE-backed issuance and a trustworthy personhood signal
remain production work.

## Contract checks demonstrated by the prototype

| property | how it dies |
| --- | --- |
| unregistered signer | contract verifies ed25519 sig under an **owner-registered key** |
| pass reuse | `sha256(exact signed bytes)` nullifier |
| pass theft | pass binds `buyer` == `predecessor_account_id` |
| repeated buys | per-epoch per-account caps; CAPTCHA/PoW does not prevent Sybil accounts |
| over-allocation | contract-specific atoms math, `pass.max_amount` encoded + per-epoch caps |

## Repo map

```
contracts/human-sale/   — the NEAR contract (near-sdk 5.30): NEP-141 + sales + verifier registry
                          `node scripts/build-contract.mjs` → target/near/human_sale.wasm
tee-gate/               — axum service: challenge, proof-of-work, pass signing, simulated evidence
webapp/                 — Vite+React: wallet, attestation inspector, human gate, buy, sniper sim
scripts/                — build-contract.mjs · deploy.mjs · register-verifier.mjs · bot-attack.mjs · gate-smoke.mjs
docs/                   — 01 idea · 02 mechanics · 03 threat model · 04 architecture · 05 runbook
                          06 research · 07 submission
res/sim-root.pub        — public key used to check the demo evidence signature
```

## Quickstart (10 minutes)

```bash
# 1. tee-gate
(cd tee-gate && cargo run -- --port 8788 --export-root ../res)

# 2. contract  (needs scripts/.env: OWNER_ID + OWNER_PRIVATE_KEY)
node scripts/deploy.mjs
node scripts/register-verifier.mjs human-gate-sim-1     # fail-closed

# 3. webapp
(cd webapp && cp .env.local.example .env.local)           # set contract + pinned sim root
(cd webapp && npm i && npm run dev)                      # localhost:5173

# 4. attacks (headless, no UI needed)
node scripts/bot-attack.mjs
```

Full walkthrough: [`docs/05-demo-runbook.md`](docs/05-demo-runbook.md).

## Contract interface (public entry points)

```text
init   new(owner, sale_id, epochs[≤8], open_cfg, total_supply, treasury_percent, token meta)
write  purchase(pass_json, sig_b64)      ← payable, human epochs only
       register_verifier(pubkey, name, evidence_hash)  revoke_verifier
       purchase_open_phase()             ← public phase, higher price
       set_paused  finalize_sale  withdraw_proceeds
view   sale_overview  buyer_state  verifiers_list  pass_used
       storage_balance_bounds   + NEP-141/storage standard set
```

Pass format (canonical JSON signed byte-exact):

```json
{"v":1,"sale":"HUMAN-001","kind":"human","buyer":"x.testnet","epoch":0,
 "max_amount":"250000","nonce":"<64 hex>","expires_at_ms":1730000000000}
```

## Current implementation and limits

- Contract implementation includes pass signature and field validation, per-account and sale caps, exact deposit checks, and a used-pass set.
- Gate, webapp, deploy script, evidence inspector, and attack walkthrough are implemented in the repository.
- The submission kit at [`docs/07-submission.md`](docs/07-submission.md) describes the current prototype and remaining publication steps.
- Default `sim` mode runs as a normal process and signs with a local key. Its
  evidence is simulated and must not be presented as hardware attestation.
- ⚠️ The contract stores an owner-approved verifier key and evidence hash; it
  does not verify the evidence or enforce an attestation measurement on-chain.
- ⚠️ The odd-one-out challenge and proof-of-work are friction, not proof that a
  buyer is a unique human. A bot can automate puzzles or hire solvers.
- ⚠️ Do not use this prototype for a real-money token launch. The sale rules,
  owner controls, verifier trust model, and any real TEE deployment need review.

## Snapshot

* ✳ sale economics: sale 30%, treasury 70%, unminted leftover is not minted
* ✳ prices 50M/30M/16.67M t/NEAR (Genesis → E3), public phase at a higher price
* ✳ verifier key registration is an owner action; evidence hash is stored but not checked by the contract
* ✳ contract pass checks are on-chain; gate issuance and simulated evidence are off-chain demo components

Hackathon submission materials: [`docs/07-submission.md`](docs/07-submission.md).
Licensing: MIT. Product rationale: [`docs/01-idea.md`](docs/01-idea.md).
