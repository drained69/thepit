// node --test pit/brain/test/proof.test.mjs — Proof of Thought pipeline vs a NEAR AI Cloud mock.
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Verify, getBlob, provenCompletion, sha256hex } from "../proof.mjs";
import { startMockNearAI } from "./mock-near-ai.mjs";

const quiet = () => {};
const payload = { model: "deepseek-ai/DeepSeek-V3.1", messages: [{ role: "user", content: "hi" }], max_tokens: 50 };

for (const kind of ["gateway", "provider_tee"]) {
  test(`${kind}: proof hashes the exact bytes and verifies`, async () => {
    const ai = await startMockNearAI({ kind });
    try {
      const { content, proof } = await provenCompletion({ aiBase: ai.base, aiKey: "test" }, payload, quiet);
      assert.match(content, /Mock thought/);
      assert.equal(proof.signature_kind, kind);
      assert.equal(proof.signing_address, ai.signingAddress);
      assert.equal(proof.request_hash, sha256hex(Buffer.from(JSON.stringify(payload))));
      // The served body re-hashes to the recorded hash and contains the text.
      const body = getBlob(proof.response_hash);
      assert.equal(sha256hex(body), proof.response_hash);
      assert.ok(body.toString().includes(content));
      const text = kind === "gateway" ? `${proof.request_hash}:${proof.response_hash}` : `${proof.model}:${proof.request_hash}:${proof.response_hash}`;
      assert.ok(ed25519Verify(text, proof.signature_hex, proof.signing_address));
      // The attestation report fetched first is kept and names the same key.
      assert.ok(getBlob(proof.attestation_hash).toString().includes(ai.signingAddress));
    } finally {
      ai.close();
    }
  });
}

test("a signature that lags the completion is waited for", async () => {
  const ai = await startMockNearAI({ lagMisses: 2 });
  try {
    const { proof } = await provenCompletion({ aiBase: ai.base, aiKey: "test" }, payload, quiet);
    assert.ok(proof);
  } finally {
    ai.close();
  }
});

test("a signature that doesn't verify produces no proof (thought stays unverified)", async () => {
  const ai = await startMockNearAI({ tamper: true });
  try {
    const { content, proof } = await provenCompletion({ aiBase: ai.base, aiKey: "test" }, payload, quiet);
    assert.ok(content);
    assert.equal(proof, null);
  } finally {
    ai.close();
  }
});

test("a rotated signing key isn't vouched for by a stale attestation", async () => {
  const ai = await startMockNearAI();
  const cfg = { aiBase: ai.base, aiKey: "test" };
  try {
    await provenCompletion(cfg, payload, quiet); // caches an attestation naming key A
    const keyB = ai.rotateKey();
    const { proof } = await provenCompletion(cfg, payload, quiet);
    assert.equal(proof.signing_address, keyB);
    assert.equal(proof.attestation_hash, null, "stale report not cited");
    const { proof: next } = await provenCompletion(cfg, payload, quiet);
    assert.ok(getBlob(next.attestation_hash).toString().includes(keyB), "next thought attests fresh");
  } finally {
    ai.close();
  }
});

test("an attestation counts only if it binds the key in report_data, for the right TEE", async () => {
  const { keyInReport } = await import("../proof.mjs");
  const k = "ab".repeat(32);
  const other = "cd".repeat(32);
  const att = (key, data = key + "00".repeat(32)) => ({ signing_address: key, report_data: data });
  const r = (o) => Buffer.from(JSON.stringify(o));
  assert.equal(keyInReport(r({ gateway_attestation: att(k) }), "gateway", k), true);
  assert.equal(keyInReport(r({ model_attestations: [att(other), att(k)] }), "provider_tee", k), true);
  // Wrong TEE for the signature kind.
  assert.equal(keyInReport(r({ model_attestations: [att(k)] }), "gateway", k), false);
  assert.equal(keyInReport(r({ gateway_attestation: att(k) }), "provider_tee", k), false);
  // Key mentioned but not bound into the quote.
  assert.equal(keyInReport(r({ gateway_attestation: att(k, other + "00".repeat(32)) }), "gateway", k), false);
  assert.equal(keyInReport(r({ note: `trust me: ${k}` }), "gateway", k), false);
  assert.equal(keyInReport(Buffer.from("not json"), "gateway", k), false);
});

test("thoughts are Borsh-encoded in the contract's field order", async () => {
  const { thoughtBorsh } = await import("../proof.mjs");
  const base = { text: "hi", model: "m", chat_id: "c", signature_kind: "gateway", request_hash: "r", response_hash: "s", signature_hex: "x", signing_address: "k" };
  const none = thoughtBorsh({ ...base, attestation_hash: null });
  // 8 strings (15 bytes of text), each with a 4-byte length, then the Option tag 0.
  assert.equal(none.length, 8 * 4 + 15 + 1);
  assert.deepEqual([...none.subarray(0, 6)], [2, 0, 0, 0, 104, 105]);
  assert.equal(none.at(-1), 0);
  const some = thoughtBorsh({ ...base, attestation_hash: "ab" });
  assert.deepEqual([...some.subarray(-7)], [1, 2, 0, 0, 0, 97, 98]);
  assert.throws(() => thoughtBorsh({ ...base, model: undefined }), /model/);
});
