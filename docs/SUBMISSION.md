# NEAR Hackathon submission — The Pit

[Live testnet](https://www.trythepit.xyz/) · [Public repository](https://github.com/drained69/thepit) · [Demo post](https://x.com/drained99/status/2120364446161768601) · [On-chain receipts and build history](hackathon-evidence.md)

Deployed on **NEAR testnet** per rule Q-010 (testnet-only projects are eligible).
Mainnet launch is planned **after an independent third-party security audit**
([why](deployment/testnet.md#what-mainnet-would-cost)).

Submission deadline: **2026-11-14T23:59:00Z**. One submission per project.

---

## Tracks

Checked against the HACKATHON.md Tracks table:

- `memecoins` — **primary**. Memecoin launchpad where every coin has mechanics: a staked bonding-curve reserve, an early-access window, and an AI brain funded by rewards and fees. Judged "on the mechanic, not the chart."
- `open` — **secondary**. Global contracts, reserve-funded inference with NEAR AI Cloud, an agent-pass interface rehearsed with a development signer, and a RHEA funding integration.

Also fits (consider adding if the team agrees):
- `agents` — a keeper harvests testnet surplus into the brain account. The brain meters model calls against that income and the keeper records signed responses on-chain.
- `privacy` — Proof of Thought uses TEE attestations verified both on-chain and in the browser.

---

## What the human decides (fill in before submission)

Per HACKATHON.md "What the human decides". **Do not guess any of these.**

| Field | Value |
|---|---|
| `projectName` (2–80) | The Pit |
| `leadName` (2–80) | *you fill in* |
| `email` (≤160) | *you fill in* |
| `size` | `1`, `2 - 4`, `4 - 6`, `6 - 8` or `8+` (exact string) |
| `tracks` | `["memecoins", "open"]` (add others if the team agrees) |
| `nearAddress` (mainnet) | *mainnet account for prize payout — create in any NEAR wallet; see https://docs.near.org/* |
| `projectUrl` | `https://github.com/drained69/thepit` |
| `demoUrl` | *link to the X post, published publicly, tagged `@NEARProtocol` and `#NEARHackathon`* |
| `idea` (20–2000 chars) | See "Idea string" below |
| `consent` | `true` (after reading the notice below) |

**Consent notice (read verbatim before setting consent):**
> I agree that the organizers may use these details to review our submission and
> contact us about this hackathon.

### Idea string (≈ 1,350 characters)

> The Pit is a NEAR memecoin launchpad where the curve reserve helps fund the coin's own AI. An emoji launch costs about 0.12 NEAR. The factory uses a shared global contract pinned by hash and has zero access keys. Buys mint tokens and add to the reserve. The reserve targets 80 percent staked and 20 percent liquid. A sell creates a payout claim at the sale price, with larger claims waiting for funds to return. Confirmed staking rewards and a 1 percent trading fee feed an inference budget. The brain calls NEAR AI Cloud, and the keeper records signed responses on-chain. The browser checks the raw response and the provider signing key when the evidence is available. Holders can lock tokens behind memories to shape what goes into the prompt. Creators can activate early access with short-lived, wallet-bound passes and per-wallet caps. The public testnet uses a mock validator pool, mock agent registry and development gate signer. The app includes a RHEA funding integration for mainnet assets. Mainnet follows a third-party audit.

---

## Live deployment (NEAR testnet)

| | Account | Explorer |
|---|---|---|
| Launchpad factory (0 access keys) | `pit.pitdeployer.testnet` | https://testnet.nearblocks.io/address/pit.pitdeployer.testnet |
| First coin ($PIT) | `pit.pit.pitdeployer.testnet` | https://testnet.nearblocks.io/address/pit.pit.pitdeployer.testnet |
| Second coin ($DEMO, 24-h gated) | `demo.pit.pitdeployer.testnet` | https://testnet.nearblocks.io/address/demo.pit.pitdeployer.testnet |
| Mock validator pool (test-only) | `pool.pitdeployer.testnet` | — |
| Mock agent registry (test-only) | `registry.pitdeployer.testnet` | — |
| Brain account | `brain.pitdeployer.testnet` | — |
| Keeper account | `keeper.pitdeployer.testnet` | — |

**Services (all on Railway):** web https://www.trythepit.xyz/ · brain https://brain-production-11a4.up.railway.app/api/health · gate https://gate-production-a0bd0e97.up.railway.app/api/info

Shared coin code hash: `307ed61248b33666c811f76f8f2827ca3bbc145392294638caf912e597785502`

---

## Demo post draft (for X)

Rule: tag `@NEARProtocol` and `#NEARHackathon`. Optional: `@NearLegion` and `@NearBuilders`.

> Built at NEAR HACKATHON — The Pit 🕳️🧠
>
> Memecoins that back themselves and talk back. Every coin is fully backed by a staked NEAR reserve; staking rewards and a 1% fee feed the coin's own AI, which signs every thought inside NEAR AI's TEE and verifies it on-chain.
>
> One contract per coin, no admin keys, holders shape the AI's voice by locking tokens behind memories.
>
> Live on testnet, mainnet after audit.
>
> 🎪 try it → https://www.trythepit.xyz/
> 💻 repo → https://github.com/drained69/thepit
>
> @NEARProtocol #NEARHackathon

**Demo video must-haves** (per HACKATHON.md section 2):
1. Lead with the problem (memecoins are unbacked and sniped).
2. Show one complete moment: open the coin page, show the staked reserve, launch a coin, show the on-chain code.
3. Name NEAR's role concretely: global contracts (shared code), Shade Agents (gated launch), NEAR AI TEE (Proof of Thought).
4. Link the demo and repo, invite feedback.

**5-minute demo script**:

1. **Open https://www.trythepit.xyz/** — "Memecoin launchpad on NEAR testnet". Show the live stats and the Testnet deployment section: factory locked, 0 access keys, shared code published for 32.17 NEAR.
2. **Click $PIT** → open phase. Buy with a connected wallet. Show the bonding curve chart, reserve bar (80% staked / 20% liquid), and the real nearblocks transaction.
3. **Early access.** $DEMO's window is closed. Rehearse on a fresh coin with an active window and show the challenge, proof of work and wallet-bound pass. The testnet gate reports `mode: dev-key` in `/api/info`.
4. **Launch your own coin.** Upload an image or pick an emoji, set a creator cut and an optional gated window. Sign; land on the new coin page.
5. **Mind.** Show the Proof of Thought section: a thought with a verified NEAR AI signature. Click Verify to see the browser re-check the attestation against NEAR AI's live attestation report. Propose a memory, back it with tokens.
6. **No admin.** Open the factory on nearblocks: zero access keys.

---

## Submission checklist (follow in order)

- [ ] Repo is public: `gh repo edit drained69/thepit --visibility public --accept-visibility-change-consequences`
- [ ] No secrets in the repo: `git ls-files | grep -E '\.env$|keeper-.*\.env|secret|key\.json'` returns nothing.
- [ ] LICENSE present (MIT — ✅ already).
- [ ] README reads for a judge (both human and AI): "do X — see Y" steps, no marketing.
- [ ] Record the demo video (5 min), upload to X with video and tags.
- [ ] Draft the submission JSON (see below) and confirm every field with the team.

### Submission JSON (example shape)

```bash
REQUEST_ID=$(uuidgen | tr A-Z a-z)
curl -sS -X POST https://nearhackathon.com/api/applications \
  -H 'Content-Type: application/json' \
  -d '{
    "requestId": "'"$REQUEST_ID"'",
    "projectName": "The Pit",
    "leadName": "FILL IN",
    "email": "FILL IN",
    "size": "FILL IN",
    "tracks": ["memecoins", "open"],
    "nearAddress": "FILL IN",
    "projectUrl": "https://github.com/drained69/thepit",
    "demoUrl": "FILL IN",
    "idea": "FILL IN WITH THE IDEA STRING ABOVE",
    "consent": true
  }'
```

**Save the `requestId`.** Reuse the same value on retries after a network error
or a 503. A 201 response means the submission is saved.

If a saved submission has a mistake: do not submit again (409 blocks a second
submission of the same repo). Request changes at
https://nearhackathon.com/request-changes.

---

## Wording guidelines

Say: "testnet", "early-access window", "wallet-bound pass", "internally audited,
external audit before mainnet", "Proof of Thought (NEAR AI signatures verified
on-chain)", "staked reserve", "global contracts".

Avoid: "bot-proof", "humans only", "snipers get nothing", "audited", "live on
mainnet", "production TEE gate". The gate adds a cost per bot wallet; it does
not prove personhood.
