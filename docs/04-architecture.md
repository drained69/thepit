# $HUMAN — prototype architecture

```text
Browser                         tee-gate (ordinary process)         NEAR testnet
  │                                      │                               │
  ├─ request challenge ─────────────────▶│                               │
  ├─ submit answer + browser PoW ───────▶│                               │
  │◀─ pass JSON + Ed25519 signature ─────┤                               │
  ├─ inspect simulated evidence locally  │                               │
  └─ purchase(pass, signature, deposit) ────────────────────────────────▶│
                                           verify registered key, pass,  │
                                           caps, deposit, nullifier; mint
```

This diagram describes the default demo. The gate is not executing inside a TEE, the evidence is simulated, and the contract does not validate evidence. The contract trusts a key because the sale owner registers it. The browser inspector does not change that on-chain trust model.

## Components

| Component | Role |
| --- | --- |
| `contracts/human-sale` | NEP-141 token and sale; validates signed pass fields and enforces caps, deposits, and one-use nullifiers. |
| `tee-gate` | Rust HTTP service; challenge sessions, proof-of-work check, pass signing, and demo evidence response. |
| `webapp` | React wallet flow, challenge UI, evidence inspector, purchase UI, and attack demo. |
| `scripts/` | Testnet deployment, owner verifier registration, gate smoke flow, and attack walkthrough. |

## Verifier registration

The owner calls `register_verifier(pubkey, name, evidence_hash)`. The contract stores the supplied key and evidence hash; it does not derive or verify either from a hardware quote. In the default runbook, the registration helper checks the simulated evidence. That is useful for demonstrating the flow but is not a production attestation verifier.

## Pass flow

1. Browser requests a challenge for an account and epoch.
2. Browser solves the challenge and proof-of-work; gate returns canonical pass bytes and an Ed25519 signature.
3. Browser displays simulated evidence and submits the pass, signature, and deposit to `purchase`.
4. Contract checks the registered key, signature, buyer, sale, epoch, expiry, amount cap, attached deposit, and unused pass hash before minting.

## Production direction

Run the pass issuer in a real TEE and obtain evidence that binds the deployed code and signing key. Independently validate that evidence and define revocation/rotation. The contract must either verify an appropriate proof itself or clearly rely on a named verifier/owner policy. Add a separate personhood signal if the product needs one-account-per-human properties; a puzzle alone cannot provide that guarantee.
