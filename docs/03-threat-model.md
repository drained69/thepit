# $HUMAN — threat model and prototype limits

Assets: sale allocation, attached NEAR, and user understanding of what the gate proves.

## Implemented contract protections

| Attack | Contract response | Limit |
| --- | --- | --- |
| Submit a pass signed by an unregistered key | Rejects verifier lookup/signature | Owner controls which key is registered. |
| Copy a pass to another account | Rejects buyer/predecessor mismatch | Compromise of the buyer wallet is outside this check. |
| Reuse a consumed pass | Rejects a used pass hash | A valid unused pass can still be submitted by its bound buyer. |
| Use an expired or wrong-sale/wrong-epoch pass | Rejects pass fields | Depends on contract time/configuration being correct. |
| Exceed amount, per-buyer, epoch, or sale caps | Rejects purchase | One human can still control multiple accounts. |
| Attach the wrong payment | Rejects payment mismatch | Users still need to understand price and storage requirements. |

## What is not established

- The default `sim` gate is an ordinary process with a simulated evidence root. It is not running in a TEE.
- The contract stores a verifier key and evidence hash through an owner action. It does not check the evidence hash against a hardware quote or enforce measured code.
- The browser's simulated evidence check is not real Intel TDX/DCAP verification. It does not make the chain independently trustless.
- The odd-one-out challenge and proof-of-work do not prove that an account belongs to a unique human. Bots can automate challenges; people can operate account farms.
- A CAPTCHA farm, compromised verifier key, malicious owner, wallet compromise, or a surge that fills an epoch can defeat the intended fairness outcome.

## Production requirements

Before a real-money launch, deploy the issuer in a supported TEE, bind its exact signing key and measured code to verifiable hardware evidence, define who validates and revokes that evidence, and reduce owner trust. Select a personhood mechanism with clear privacy and accessibility properties. Obtain an independent contract and economic review. Until then, treat this as a testnet prototype for pass-bound settlement and replay protection.
