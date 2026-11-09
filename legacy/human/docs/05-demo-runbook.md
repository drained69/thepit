# 05 — Demo runbook

End-to-end run, cheapest path first. Total demo time ≈ **10 minutes**.

## 0. Prerequisites

| tool | check |
| --- | --- |
| Rust 1.97.1 + `rustup` | `rustup run 1.97.1 rustc --version` |
| Node ≥ 20 | `node -v` |
| A NEAR **testnet** account with ~2 NEAR | ` OWNER_ID=yourname.testnet`, key from wallet export |
| Optional attestation preflight | `NEAR_AI_CLOUD_API_KEY` (does not enable pass issuance) |

Create `scripts/.env`:

```
OWNER_ID=yourname.testnet
OWNER_PRIVATE_KEY=ed25519:5ABC...
GATE_URL=http://localhost:8788
```

## 1. Start the gate (simulated-evidence mode)

```bash
cd tee-gate
cargo run -- --port 8788 --mode sim --sale-id HUMAN-001 \
             --export-root ../res
# prints:
#   tee-gate up:  http://0.0.0.0:8788
#   sim-root.pub: 829f…c7ca99  (written to ~/.human-gate/sim-root.pub)
```

Verify: `curl localhost:8788/api/info` → shows mode `sim`, signing_address, policy_hash.

The optional `nearai` feature fetches NEAR AI Cloud attestation-related responses,
but this prototype does not establish an end-to-end TEE-bound pass issuer or have
the contract verify a hardware quote. Do not present that mode as production TEE
enforcement. Use the explicitly labeled simulated mode for the submission demo.

## 2. Deploy the contract

The deploy script first compiles the Wasm with `scripts/build-contract.mjs`, then
deploys and initializes it on testnet.

```bash
node scripts/deploy.mjs
```

What it does:
1. batch tx: `deploy_contract(wasm)` + `new({ owner, sale_id: "HUMAN-001", epochs, open_cfg, … })`
2. epochs (demo timeline, 2 min from now, each 5 min):
   | epoch | tokens/NEAR | per-buyer cap | epoch cap |
   | --- | --- | --- | --- |
   | 1 Genesis | 50,000,000 | 2M | 30M |
   | 2 | 30,000,000 | 10M | 80M |
   | 3 | 16,666,666 | 30M | 140M |
   | public phase | 6,666,666 | 10M | 50M |
3. pre-mints 700M to owner as treasury; registers owner for NEP-141.

## 3. Register the verifier (fail-closed)

```bash
node scripts/register-verifier.mjs human-gate-sim-1
```

The script:
1. fetches `GET /api/gate/attestation?nonce=...`
2. verifies the quote signature under **res/sim-root.pub** ✅
3. checks `attributes_debug=false`, policy_hash match, quote→key binding ✅
4. refuses registration if any simulated-evidence check fails
5. `register_verifier(pubkey_hex, name, evidence_hash)` on-chain

**Anyone** can re-verify the pinned key off-band:
`node scripts/gate-smoke.mjs yourname.testnet 8788` replays the pass-signature
and quote checks locally (no chain, no credentials).

## 4. Buy with a pass

Before launching the webapp, copy `webapp/.env.local.example` to
`webapp/.env.local`. Set `VITE_SALE_CONTRACT` to the account that `deploy.mjs`
deployed to. Set `VITE_SIM_ROOT_PUBKEY` to the exact `sim_root_pubkey` printed by
`curl http://localhost:8788/api/info`; the browser refuses to accept a report
signed by any other root. Restart Vite after changing this file.

```bash
cd webapp && npm run dev   # or npm run preview after npm run build
```

Open the app: **① Connect** → **③ Gate** (challenge + browser PoW,
gets a signed pass) → **④ Buy** → `storage_deposit` → `purchase()`.
The Buy tab refuses to run without a valid pass for *your own account*.

## 5. Attack walkthrough (Sniper Simulator)

Same webapp, tab ⑤ (buttons send REAL txs and print the on-chain refusal), or
headless:

```bash
node scripts/bot-attack.mjs
```

Expected scoreboard:

```
A1 raw purchase (no pass):          🛑 blocked → UnknownVerifier
A2 stolen pass (other buyer):       🛑 blocked → PassNotForYou
A3 replay of a used pass:           🛑 blocked → PassReplay
```

## 6. Recording the X demo post

1. record: gate challenge → pass → simulated evidence inspector (keep the disclosure visible)
2. record: buy tab mint ✅ (explorer link)
3. record: snipers tab — two red on-chain refusals
4. post as video/GIF with tag @NEARProtocol + #NEARHackathon (drafts in docs/human/07-submission.md)

## Troubleshooting

- **gate EADDRINUSE** NightWatch/other app owns 8787 → use `--port 8788` (our default dev port).
- **`epochs must start in the future`** rerun deploy (timeline recomputed live).
- **`UnknownVerifier`** register-verifier before epoch 1; if the gate restarted *and* the
  storage dir was wiped, re-register (keys are in `~/.human-gate/`).
- **`IncludeStorageDeposit`** run the Buy tab's "storage deposit" button first.
- **pass expired** pass TTL is 5 min; grab a fresh one at the Gate tab.
