/**
 * Browser proof-of-work: find X with sha256(nonce + ':' + X) < target.
 * Target is ~2^62-wide — instant on a laptop, rate-bounds scripted farming.
 */
import { sha256 } from "@noble/hashes/sha256";

export function solvePow(
  nonce: string,
  target: bigint,
  onProgress?: (attempts: number) => void
): string {
  const prefix = new TextEncoder().encode(nonce + ":");
  let i = 0;
  for (i = 0; i < 5_000_000_000; i++) {
    const h = sha256(concat(prefix, new TextEncoder().encode(String(i))));
    const hi = new DataView(h.buffer, h.byteOffset, h.byteLength).getBigUint64(0);
    if (hi < target) break;
    if (onProgress && i % 100_000 === 0) onProgress(i);
  }
  if (i >= 5_000_000_000) throw new Error("pow_no_solution");
  return String(i);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
