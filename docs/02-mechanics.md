# $HUMAN — Sale mechanics (frozen spec, v1)

This is the normative spec implemented by `contracts/human-sale` and consumed by
`tee-gate` and `webapp`. Any change must bump `spec_version`.

## Token

| Field | Value |
| --- | --- |
| Token | `HUMAN` (NEP-141), decimals `24` |
| Total supply | `1_000_000_000` × 10²⁴ |
| Sale allocation | 30 % (300M) — minted by the contract itself, only through the sale |
| Remainder | 70 % pre-minted to owner as transparent treasury: 25 % LP, 30 % community vault, 15 % team-vesting (documented; vesting enforced off-chain in the demo wallet, in-protocol in production) |

Demo supply numbers are testnet-scale; the mechanic is what matters.

## Phases (strict order)

Sale = `epochs[0..3]` (pass-gated) → `open phase` → `finalized`.

| Phase | Who can buy | Price (tokens per NEAR) | Per-buyer cap | Supply cap |
| --- | ---: | ---: | ---: | ---: |
| Epoch 1 "Genesis" | Accounts with valid pass | 50,000,000 | 2,000,000 | 30,000,000 |
| Epoch 2 | Accounts with valid pass | 30,000,000 | 10,000,000 | 80,000,000 |
| Epoch 3 | Accounts with valid pass | 16,666,666 | 30,000,000 | 140,000,000 |
| Public phase | Anyone | 6,666,666 (= epoch 3 ÷ 3) | 10,000,000 | remainder (50,000,000) |

- Pass-gated epochs are **time-boxed** (e.g. 24h each in production; minutes in testnet demo).
- Unsold tokens roll into the next phase. If pass-holding accounts take the full sale
  allocation, the open phase has no supply; the gate does not establish that buyers are
  unique humans.
- Price rises per epoch. After priority windows, a public phase uses a worse price. Caps and pass requirements shape allocation but do not prevent
  Sybil accounts or challenge-solving services.
- `finalize()` can only run after `sale_end`; it closes the phase and (in production) pushes
  the leftover + a slice of proceeds to a community vault / burn.

## The oracle primitive: `human-pass`

A pass is a **canonical JSON string** signed with Ed25519 by a registered verifier's key.

```json
{
  "v": 1,
  "sale": "HUMAN-001",
  "kind": "human",
  "buyer": "alice.testnet",
  "epoch": 1,
  "max_amount": "250000",
  "nonce": "b7f6…64 hex chars",
  "expires_at_ms": 1730000000000
}
```

Rules:

- `max_amount` is a decimal string for exact u128 parsing; `epoch` and `expires_at_ms` are JSON integers.
- The contract verifies `env::ed25519_verify(sig, token.as_bytes(), verifier_pubkey)`.
- The exact signed bytes equal the exact bytes submitted on-chain (no canonicalization —
  the UI sends what the verifier signed).
- `buyer` must equal `predecessor_account_id` — **steal-the-pass / copy-the-tx both fail**.
- `hash(token)` is recorded on use; replay flips to `PassReplay`.
- `expires_at_ms` gives passes a bounded life (5 min default) to prevent pass markets.

## Verifier registration (attestation binding)

The contract owns a set of verifiers:

```rust
Verifier {
  pubkey: [u8; 32],        // signing key ("signing_address" hex in evidence)
  name: String,             // operator name ("NEAR-AI-CLOUD/gpt-oss-…", "human-gate-nitro-1")
  evidence_hash: [u8; 32],  // sha256 of the attestation evidence bundle that approved it
  approved: bool,
}
```

Trust path (who voted this key in?):

- **Current demo:** owner registers the verifier key and an evidence hash. The demo helper
  checks a simulated evidence bundle; the contract itself does not validate evidence or
  TEE measurements. This is an owner trust decision, not a trustless attestation proof.
- **Production direction:** run the issuer in a real TEE, independently validate a report
  binding its key and code, and define an auditable validation/revocation path.

## On-chain checks in `purchase(pass, sig)` — cost budget

| Check | Cost driver |
| --- | --- |
| `env::ed25519_verify` | one key check per registered verifier scanned (registry capped at 8) |
| strict JSON parse of pass + field validation | ~150-byte payload, serde_json |
| sha256(pass) replay record | hash + `UnorderedSet` insert |
| price math + caps + storage deposit handling | trivial |
| **Total** | Measure on the deployed testnet contract before making a gas claim. |

## Events (NEP-297 standard format)

- `human_purchase { buyer, epoch, amount_tokens, verifier_name, pass_hash }`
- standard NEP-141 events for mints/transfers.
- Failed purchase transactions revert (there is no event on revert); the webapp and the
  sniper simulator *show* the rejections locally, and any indexer sees them as failed
  transactions — that is where the public "bot carnage" dashboard comes from.

## Failure modes surfaced by the contract

`PassUnknownVerifier` · `PassNotForYou` · `PassReplay` · `PassExpired` ·
`PassWrongSale` · `PassExceedsAmount` · `EpochClosedOrFuture` · `PerBuyerCap` ·
`WrongAttachedDeposit` · `SalePaused` · `NotEnoughSupply`
