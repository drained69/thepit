# $HUMAN — pass-gated priority launches on NEAR

> Track fit: **Memecoins With Mechanics** (primary), **Open Innovation** (secondary).

## Product in one sentence

$HUMAN is a NEAR token-sale prototype where a short-lived, wallet-bound pass unlocks priority buying windows, and the contract enforces the sale rules and settlement.

## The problem

Public launches often reward block-zero speed and private trading infrastructure. $HUMAN moves initial eligibility into explicit, time-boxed windows: a signed ticket names the buyer, sale, epoch, spending cap, expiry, and one-use nonce. The contract applies the same price, limits, and replay rules to every transaction. A challenge can add friction, but CAPTCHA-style puzzles and proof-of-work cannot prove unique personhood; bots can automate them and solvers can be hired.

## What is implemented

1. A Rust gate presents a short challenge and browser proof-of-work, then issues an Ed25519 pass bound to the buyer account, sale, epoch, token cap, expiry, and nonce.
2. The NEAR contract verifies a registered verifier signature, checks the pass fields and exact deposit, enforces epoch and per-account caps, and rejects a reused pass hash.
3. The demo includes a simulated evidence report, an inspector, wallet purchase flow, and replay/pass-theft demonstrations.

The default gate runs as an ordinary process. The simulated report is not hardware attestation. The owner registers the verifier key and evidence hash; the contract does not validate TEE evidence. The prototype demonstrates pass-gated settlement, not trustless TEE verification or proof of unique humans. Valid pass holders can still compete for a limited epoch allocation. After the priority windows, the configured public phase is permissionless at a worse price, so the product reduces block-zero sniping during priority windows; it does not promise that bots can never buy.

## Why NEAR

- The contract uses NEAR's Ed25519 verification host function for pass signatures.
- NEAR account IDs make the buyer binding legible in the pass and transaction.
- The prototype uses NEP-141 conventions for token settlement.

## Demo story

Connect a testnet wallet, request a challenge, obtain a pass, buy during an active priority epoch, then show the contract rejecting a replay and a pass submitted from another account. Keep the simulated-attestation disclosure visible in the video and README.

## Next production milestones

- Run issuance inside a real TEE and independently verify the hardware evidence before key registration.
- Make the attestation-to-key policy enforceable and auditable; current registration is an owner trust decision.
- Choose an explicit personhood strategy and describe its privacy, accessibility, and Sybil limits.
- Review sale economics, owner powers, emergency behavior, and token distribution before any real-money launch.
