import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

type ThoughtProof = {
  signature_kind: string;
  model: string;
  request_hash: string;
  response_hash: string;
  signature_hex: string;
  signing_address: string;
  text: string;
};

const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
export const sha256Hex = (body: Uint8Array) => Array.from(sha256(body), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function verifyThoughtSignature(thought: ThoughtProof): Promise<boolean> {
  const { signature_kind, model, request_hash, response_hash, signature_hex, signing_address } = thought;
  if (signature_kind !== "provider_tee" && signature_kind !== "gateway") return false;
  if (![request_hash, response_hash, signing_address].every((value) => /^[0-9a-f]{64}$/i.test(value)) || !/^[0-9a-f]{128}$/i.test(signature_hex)) return false;
  const hashes = `${request_hash}:${response_hash}`;
  const signed = signature_kind === "provider_tee" ? `${model}:${hashes}` : hashes;
  try {
    return await ed.verifyAsync(fromHex(signature_hex), new TextEncoder().encode(signed), fromHex(signing_address));
  } catch {
    return false;
  }
}

export function checkThoughtResponse(thought: ThoughtProof, body: Uint8Array) {
  const hashMatches = sha256Hex(body) === thought.response_hash;
  if (!hashMatches) return { hashMatches, textMatches: false };
  try {
    const content = JSON.parse(new TextDecoder().decode(body))?.choices?.[0]?.message?.content;
    return { hashMatches, textMatches: typeof content === "string" && content.trim() === thought.text };
  } catch {
    return { hashMatches, textMatches: false };
  }
}

// Generated once with a local Ed25519 test key. Only the public key and
// signature are retained. The sample makes no claim of NEAR AI provenance.
export const SAMPLE_RESPONSE = '{"choices":[{"message":{"content":"I ate 0.2 NEAR of fees today. I can now count to four."}}]}';
export const SAMPLE_PROOF: ThoughtProof = {
  text: "I ate 0.2 NEAR of fees today. I can now count to four.",
  model: "Sample response",
  signature_kind: "gateway",
  request_hash: "cc7f8715fe70aea5a7740a1d330c225468b62581f28f460f2c0bae6fc0bf4375",
  response_hash: "04c4b3c929110e3fa9c572fce0e3a41ce22238c0303ca9f2fa8da09454855d4e",
  signing_address: "aef2693ea2c81318c812e7b755cdfa5090bd7deee3d317575acf161ae3e4eb0d",
  signature_hex: "e77f98ab7ae2d43b7c7fa7966c062780a9f92d9c334207554fd49ba75a891bdd243c1a02a22dc5afbbee4e7cbe8bb322cfbe9884ae13b3be8272786e5189c30b",
};
