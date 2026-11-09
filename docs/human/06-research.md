# 06 — Design notes and open research

## Problem framing

Public token launches can reward low-latency trading infrastructure and large numbers of accounts. Common allocation tools include per-wallet caps, allowlists, deposits, CAPTCHA checks, and proof-of-personhood services. They make different tradeoffs in privacy, accessibility, cost, and resistance to account farming. None should be described as universal proof that a wallet belongs to one unique human.

## Prototype design choice

This repository demonstrates signed, account-bound allocation passes. The pass separates off-chain eligibility logic from on-chain settlement: the NEAR contract can verify a signature and enforce buyer binding, expiry, amount limits, and one-use consumption. The default demo uses simulated evidence and owner-registered verifier keys. It does not currently demonstrate real TEE execution or a decentralized attestation decision.

## Production questions to resolve

1. **Attestation trust:** Which TEE vendor and verifier will validate hardware reports? How are measured code, key rotation, revocation, and verifier outages handled?
2. **Personhood:** What evidence is sufficient for the intended launch? What privacy data is collected, and how can users appeal false rejection?
3. **Sybil economics:** What caps and sale windows limit the damage from multiple accounts, hired solvers, or a compromised issuer?
4. **Fair allocation:** Should allocation use a queue, lottery, equal per-account cap, or other rule? How are failed/abandoned purchases handled?
5. **Token operations:** How are treasury allocations, proceeds, unsold supply, pauses, and owner powers constrained and disclosed?

These are product and governance decisions, not guarantees supplied by a TEE. A TEE can provide evidence about code execution and protect keys under stated hardware assumptions; it cannot establish that a challenge solver is a unique human.
