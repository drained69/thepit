/**
 * Verifies the tee-gate evidence bundle in-browser.
 *   mode "SIMULATED": ed25519(sim-root.pub, quote_b64 bytes) === quote_sig_b64,
 *     and the quote binds {signing_address, policy_hash, request_nonce}.
 *   mode "NEAR-AI-CLOUD": attestation preflight only; this UI intentionally
 *     refuses to treat it as a verified pass-signing key.
 *
 * The same checks anyone can replay off-band; the on-chain part only ever
 * trusts the ed25519 pass signature under a PINNED verifier key.
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { SIM_ROOT_PUBKEY_HEX } from "./config";

export interface EvidenceReport {
  ok: boolean;
  badge: string;
  lines: string[];
}

// @noble/ed25519 v2: async API needs no hash wiring.

const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const b64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

export async function verifyEvidence(
  evidence: any,
  expected?: { requestNonce: string; signingAddress: string; policyHash: string }
): Promise<EvidenceReport> {
  const lines: string[] = [];
  if (!evidence) return { ok: false, badge: "NO EVIDENCE", lines: ["verifier sent no evidence"] };

  if (evidence.mode === "SIMULATED") {
    lines.push(`mode: SIMULATED EVIDENCE (signed demo report; not hardware attestation)`);
    const rootHex = SIM_ROOT_PUBKEY_HEX.trim().toLowerCase();
    if (!rootHex) return { ok: false, badge: "UNPINNED REPORT", lines: [...lines, "set VITE_SIM_ROOT_PUBKEY to the gate's public root before issuing demo passes"] };
    if ((evidence.sim_root_pubkey as string)?.toLowerCase() !== rootHex) {
      return { ok: false, badge: "ROOT KEY MISMATCH", lines: [...lines, "report root does not match the key pinned in the webapp build"] };
    }

    // 1. quote signature verifies under the sim root
    const msg = b64(evidence.quote_b64);
    const sig = b64(evidence.quote_sig_b64);
    const okSig = await ed.verifyAsync(sig, msg, hex(rootHex));
    lines.push(`quote signature under sim root: ${okSig ? "✅ valid" : "❌ invalid"}`);
    if (!okSig) return { ok: false, badge: "UNVERIFIED", lines };

    // 2. quote payload structure + bindings
    const payload = JSON.parse(new TextDecoder().decode(msg));
    const debugOk = payload.tdx?.attributes_debug === false;
    lines.push(`attribute_debug=false: ${debugOk ? "✅" : "❌"}`);
    const pkOk = payload.signing_address === evidence.signing_address;
    lines.push(`quote binds gate signing key: ${pkOk ? "✅" : "❌"}`);
    const responseKeyOk = !expected || payload.signing_address === expected.signingAddress;
    lines.push(`quote key matches pass signer: ${responseKeyOk ? "✅" : "❌"}`);
    const nonceOk = !expected || payload.request_nonce === expected.requestNonce;
    lines.push(`quote nonce matches pass: ${nonceOk ? "✅" : "❌"}`);
    const policyOk = !expected || payload.policy_hash === expected.policyHash;
    lines.push(`quote policy matches response: ${policyOk ? "✅" : "❌"}`);
    const rtmrsOk = [payload.tdx?.rtmr0, payload.tdx?.rtmr3].every((v: string) => /^[0-9a-f]{64}$/.test(v || ""));
    lines.push(`RTMR measurements present: ${rtmrsOk ? "✅" : "❌"}`);
    lines.push(`policy_hash: ${payload.policy_hash?.slice(0, 16)}…`);

    const ok = debugOk && pkOk && rtmrsOk && responseKeyOk && nonceOk && policyOk;
    return { ok, badge: ok ? "SIMULATED REPORT SIGNATURE ✅ VERIFIED" : "FAILED CHECK", lines };
  }

  if (evidence.mode === "NEAR-AI-CLOUD") {
    lines.push(`mode: NEAR AI CLOUD (attestation preflight only)`);
    const count = (evidence.model_attestations_count as number) ?? 0;
    lines.push(`intel_quote bundles received: ${count}`);
    if (count > 0 && evidence.raw) {
      const first = evidence.raw?.model_attestations?.[0] ?? {};
      lines.push(`provider: ${first.provider ?? "?"} · sign_algo: ${first.signing_algo ?? "?"}`);
      lines.push(`the current app does not verify this quote or bind it to the local pass-signing key`);
    }
    return { ok: false, badge: count > 0 ? "PREFLIGHT ONLY · PASS DISABLED" : "NO ATTESTATION", lines };
  }

  return { ok: false, badge: "UNKNOWN MODE", lines: [`unsupported evidence mode: ${evidence.mode}`] };
}

export async function verifyPassSignature(pass: string, signatureB64: string, publicKeyHex: string): Promise<boolean> {
  try {
    return await ed.verifyAsync(b64(signatureB64), new TextEncoder().encode(pass), hex(publicKeyHex));
  } catch {
    return false;
  }
}

/** sha256 hex — parity with the evidence_hash the register script pins. */
export const sha256Hex = (bytes: Uint8Array) => {
  const d = sha256(bytes);
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
};
