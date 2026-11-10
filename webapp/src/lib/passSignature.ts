/**
 * Checks an early-access pass signature in the browser before buying, so a
 * buyer never spends a transaction on a pass the contract would reject.
 * The contract verifies the same Ed25519 signature over the same bytes.
 */
import * as ed from "@noble/ed25519";

const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const b64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

/** True if `signatureB64` is a valid Ed25519 signature of `pass` by `publicKeyHex`. */
export async function verifyPassSignature(pass: string, signatureB64: string, publicKeyHex: string): Promise<boolean> {
  try {
    return await ed.verifyAsync(b64(signatureB64), new TextEncoder().encode(pass), hex(publicKeyHex));
  } catch {
    return false;
  }
}
