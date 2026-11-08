# NEAR Hackathon submission kit

Submission deadline: **14 November 2026, 23:59 UTC**. The form requires a public repository URL and a public X post with a demo video or screenshots. The post must say the project was built at NEAR HACKATHON, tag `@NEARProtocol`, and include `#NEARHackathon`.

## Recommended track

Primary: **Memecoins With Mechanics**. Secondary: **Open Innovation**. The product changes the launch mechanic by reserving the first allocation for accounts holding a short lived, account-bound pass; purchases and pass replay protection settle on NEAR.

## Project title

**$HUMAN — fair launch allocation on NEAR**

## Short description for the form

> $HUMAN is a NEAR token sale prototype that gates early allocation with short lived, wallet-bound passes. A Rust gate issues Ed25519-signed passes after a challenge and proof-of-work; the NEAR contract checks the registered verifier signature, buyer, sale, epoch, expiry, amount cap, exact deposit, and one-use nullifier before minting. The demo includes a simulated attestation mode and a bot-attack walkthrough. This prototype demonstrates verifiable pass-gated settlement; it does not prove unique personhood or run its default gate inside production TEE hardware.

This is within the form's 20–2,000 character limit.

## Demo post draft

> Built at NEAR HACKATHON: $HUMAN explores fairer token launches with wallet-bound, one-use allocation passes and on-chain enforcement. In this demo, watch a pass get issued, a purchase settle on NEAR testnet, then see replay and pass-theft attempts rejected. Attestation is simulated in this build; unique personhood is an open problem. Repo: [PUBLIC REPOSITORY URL] @NEARProtocol #NEARHackathon

Attach a short screen recording showing the connected wallet, gate/pass issuance, successful testnet purchase with explorer link, then rejected replay and different-wallet pass attempt. Do not describe the simulated inspector as live Intel TDX verification.

## Readiness checklist

- [ ] Publish this workspace as a **public** Git repository. This workspace snapshot currently has no `.git` directory, so there is no repository URL to submit yet.
- [ ] Run through [`docs/05-demo-runbook.md`](05-demo-runbook.md) using a fresh testnet deployment and record the real transaction links.
- [ ] Record and publish the demo X post; replace the placeholder in the draft above.
- [ ] Submit the same public repository URL and X post URL in the [NEAR Hackathon form](https://nearhackathon.com/#apply).
- [ ] Fill in project name, team lead, email, team size, NEAR wallet, tracks, links, and the description above. The form says one submission per project.
- [ ] Confirm no credentials, private keys, or generated local key files are included in the public repository.

## Claims to use consistently

- Say **pass-gated** or **bot-resistant allocation prototype**, not “bot-proof” or “real humans only.” A CAPTCHA-like puzzle and browser proof-of-work do not establish unique human identity.
- Say **simulated attestation** for the default mode. The repository's default gate is not executing inside a TEE.
- Say **the contract verifies a registered verifier's Ed25519 signature**. Verifier registration is an owner action that pins a key and evidence hash; the contract does not validate TEE attestation evidence itself.
- Describe live TEE-backed issuance and independent personhood signals as future work until they are implemented and demonstrated end-to-end.
