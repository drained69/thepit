import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkThoughtResponse, SAMPLE_PROOF, SAMPLE_RESPONSE, sha256Hex, verifyThoughtSignature } from "../src/lib/thought-proof.ts";

const encode = (value) => new TextEncoder().encode(value);

test("the preview verifies a signed fixture and rejects a modified hash", async () => {
  assert.equal(await verifyThoughtSignature(SAMPLE_PROOF), true);
  assert.equal(await verifyThoughtSignature({ ...SAMPLE_PROOF, response_hash: "0".repeat(64) }), false);
  assert.equal(await verifyThoughtSignature({ ...SAMPLE_PROOF, signature_kind: "unknown" }), false);
});

test("the browser checks both the exact response bytes and displayed text", () => {
  assert.deepEqual(checkThoughtResponse(SAMPLE_PROOF, encode(SAMPLE_RESPONSE)), { hashMatches: true, textMatches: true });
  assert.deepEqual(checkThoughtResponse(SAMPLE_PROOF, encode(SAMPLE_RESPONSE + "\n")), { hashMatches: false, textMatches: false });
  assert.deepEqual(checkThoughtResponse({ ...SAMPLE_PROOF, text: "Modified text" }, encode(SAMPLE_RESPONSE)), { hashMatches: true, textMatches: false });
});

test("the archived $PIT response matches the hash in thought #170's receipt", () => {
  const hash = "485018fc36787623138d2eb61f84b9a04430a0128848cce0171618518b342d86";
  const bytes = readFileSync(new URL(`../src/evidence/${hash}.json`, import.meta.url));
  assert.equal(sha256Hex(bytes), hash);
  assert.equal(sha256Hex(encode(bytes.toString("utf8"))), hash);
});
