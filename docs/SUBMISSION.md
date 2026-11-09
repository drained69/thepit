# NEAR Hackathon submission — The Pit

**Network: NEAR testnet.** Mainnet launch is planned **after an independent
third-party security audit** ([why](deployment/testnet.md#what-mainnet-would-cost)).

Deadline: **14 November 2026, 23:59 UTC**. The form needs a public repository
URL and a public X post with a demo video or screenshots. The post must say the
project was built at NEAR HACKATHON, tag `@NEARProtocol` and include
`#NEARHackathon`.

## Tracks

- **Primary: Memecoins With Mechanics.** Every coin has a fully backed bonding
  curve, a staked reserve, an early-access launch window and an AI "brain" fed
  only by its own staking yield and fees.
- **Secondary: Open Innovation.** NEAR global contracts make each launch cost
  ~0.12 NEAR. Proof of Thought records NEAR AI TEE signatures on-chain, and the
  gate runs as a NEAR Shade Agent.

## Title

**The Pit — memecoins that grow a brain**

## Short description (for the form)

> The Pit is a NEAR memecoin launchpad where every coin is fully backed and feeds its own AI. Anyone launches a coin in one transaction for about 0.12 NEAR. All coins share one contract, published once as a NEAR global contract and pinned by hash, and the launchpad has no admin keys. Buys and sells run on a bonding curve. The NEAR behind it is staked with validators, a liquid buffer pays sellers instantly, and larger sells are queued at a fixed price until stake returns. Staking rewards and a 1% fee are the coin's only income, harvested to its "brain": an AI that posts as the coin, signs every thought through NEAR AI Cloud's TEE, and records that signature on-chain (Proof of Thought), which anyone can re-verify in the browser. Holders shape its personality by locking tokens behind memories (conviction voting). Creators can add an early-access window, where buyers need a short-lived, wallet-bound pass from a gate running as a NEAR Shade Agent, with per-wallet caps. Cross-chain funding via RHEA lets EVM users top up a NEAR wallet. Deployed on NEAR testnet for the hackathon; mainnet will follow a third-party audit.

(≈ 1,130 characters; the form allows 20–2,000.)

## X post draft

> Built at NEAR HACKATHON: The Pit 🕳️🧠 — a memecoin launchpad where every coin is fully backed, its reserve is staked, and the yield feeds the coin's own AI. Every thought is signed in NEAR AI's TEE and verified on-chain. Live on NEAR testnet; mainnet after an external audit. [REPO URL] @NEARProtocol #NEARHackathon

Attach the demo video recorded with [the testnet demo script](deployment/testnet.md#7-demo-script--5-minutes).

## Checklist

- [ ] Deploy to testnet: [testnet runbook](deployment/testnet.md), steps 2–6.
- [ ] Record the demo (step 7) with nearblocks links for each transaction.
- [ ] Make the repository public: `https://github.com/drained69/thepit`. First check that no `.env`, `.keeper-*.env` or key files are tracked:
      `git ls-files | grep -E '\.env|keeper|secret|key\.json'` should print nothing.
- [ ] Rotate the RHEA API key mentioned in the mainnet guide before the repo goes public.
- [ ] Publish the X post; paste the repo URL into it.
- [ ] Submit the repo URL and X post URL in the [NEAR Hackathon form](https://nearhackathon.com/#apply) (one submission per project).

## Status, stated plainly

| | |
|---|---|
| Network | NEAR testnet |
| Contracts | Coin (321,756 B) + factory, same code as planned for mainnet; hashes in [`deployment/artifacts.json`](deployment/artifacts.json) |
| Testing | 93 coin + 10 factory contract tests, 6 sandbox end-to-end runs, a 10,000-operation invariant simulation, 80 service/web tests, and local-node deploy rehearsals |
| Security review | Internal audit with every finding fixed ([report](audits/MAINNET_READINESS_2026_11_09.md)); **no external audit yet** |
| Mainnet | After a third-party audit; costs ≈ 36.27 NEAR to deploy, 32.18 of it a permanent burn |
| Test-only on testnet | Mock validator pool, mock agent registry, gate in `dev-key` mode (not in a TEE) |

## Wording

Use: "testnet", "early-access window", "wallet-bound pass", "internally audited,
external audit before mainnet", "Proof of Thought (NEAR AI signatures verified
on-chain)".

Avoid: "bot-proof", "humans only", "snipers get nothing", "audited", "live on
mainnet", "production TEE gate". The gate adds a cost per bot wallet; it does
not prove personhood.
