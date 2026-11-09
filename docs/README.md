# Documentation

| Document | What it covers |
|---|---|
| [SUBMISSION.md](SUBMISSION.md) | NEAR Hackathon submission kit: tracks, description, demo post, checklist, wording |
| [architecture.md](architecture.md) | Trust boundaries between contracts, services, wallets and external providers |
| [deployment/testnet.md](deployment/testnet.md) | Testnet deployment and 5-minute demo runbook (the hackathon build) |
| [deployment/mainnet.md](deployment/mainnet.md) | Mainnet guide, deferred until a third-party audit |
| [deployment/artifacts.json](deployment/artifacts.json) | Sizes and SHA-256 of the contract artifacts to deploy (`npm run artifacts`) |
| [deployment/release.json](deployment/release.json) | Record of the web and brain preview release on Railway |

## Security reviews

Newest first. Each report lists findings, severity, evidence and how each was resolved.

| Report | Scope |
|---|---|
| [MAINNET_READINESS_2026_11_09.md](audits/MAINNET_READINESS_2026_11_09.md) | **Current.** Full contracts + services review, proofs of concept, fix log, size optimisation, local-node rehearsals |
| [SECOND_AUDIT_2026_11_08.md](audits/SECOND_AUDIT_2026_11_08.md) | Second pass and release preparation |
| [CONTRACT_AUDIT_2026_11_08.md](audits/CONTRACT_AUDIT_2026_11_08.md), [SERVICE_AUDIT_2026_11_08.md](audits/SERVICE_AUDIT_2026_11_08.md), [SERVICE_AUDIT_SECOND_PASS_2026_11_08.md](audits/SERVICE_AUDIT_SECOND_PASS_2026_11_08.md), [FRONTEND_AUDIT_2026_11_08.md](audits/FRONTEND_AUDIT_2026_11_08.md) | Component reviews |
| [AUDIT_2026_11_08.md](audits/AUDIT_2026_11_08.md), [AUDIT_2026_FOLLOWUP.md](audits/AUDIT_2026_FOLLOWUP.md), [AUDIT_REPORT.md](audits/AUDIT_REPORT.md) | Earlier reviews |

All reviews are internal. Mainnet launch waits for an independent third-party audit.

## Component docs

[Contracts](../pit/contracts/README.md) · [Mechanics and interfaces](../pit/README.md) ·
[Brain](../pit/brain/README.md) · [Launch gate](../pit/gate-agent/README.md) ·
[Scripts](../pit/scripts/README.md) · [Web app](../webapp/README.md) ·
[RHEA integration](../pit/RHEA_INTEGRATION.md) · [Earlier $HUMAN prototype](../legacy/human/README.md)
