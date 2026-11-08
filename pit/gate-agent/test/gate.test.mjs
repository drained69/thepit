// node --test pit/gate-agent/test — gate logic without network or Shade.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { checkPow, createGate, DEFAULT_POLICY, generateChallenge } from "../src/gate.mjs";
import { randomNearSecret, signerFromNearSecret } from "../src/keys.mjs";

const signer = signerFromNearSecret(randomNearSecret());
const gate = (now = Date.now) =>
  createGate({ saleId: "PIT-001", verifierName: "t", signerId: signer.accountId, mode: "dev-key", sign: signer.sign, now,
    makeChallenge: () => generateChallenge(Buffer.from([0, 1, 1, 2, 3, 4, 5, 1, 0])) });

function solve(nonce) {
  for (let i = 0; ; i++) if (checkPow(nonce, String(i), DEFAULT_POLICY.powTarget)) return String(i);
}

function verifyEd25519(pass, sigB64, accountId) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(accountId, "hex")]);
  return crypto.verify(null, Buffer.from(pass), crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(sigB64, "base64"));
}

test("agent account id is the hex of its ed25519 public key (implicit account)", () => {
  assert.match(signer.accountId, /^[0-9a-f]{64}$/);
  const again = signerFromNearSecret(signer.nearSecret);
  assert.equal(again.accountId, signer.accountId);
});

test("challenge always has exactly one odd item, at the answer position", () => {
  for (let i = 0; i < 500; i++) {
    const c = generateChallenge(crypto.randomBytes(16));
    assert.equal(new Set(c.view.options).size, 3);
    assert.ok(["0", "1", "2"].includes(c.answer));
  }
});

test("correct answer + pow → pass signed by the agent key, tee-gate field order", () => {
  const g = gate();
  const ch = g.challenge("alice.testnet", "0").body;
  const res = g.verify({ session_id: ch.session_id, pow_solution: solve(ch.nonce), answer: "1" });
  assert.equal(res.status, 200);
  const p = JSON.parse(res.body.pass);
  assert.deepEqual(Object.keys(p), ["v", "sale", "kind", "buyer", "epoch", "max_amount", "nonce", "expires_at_ms"]);
  assert.equal(p.buyer, "alice.testnet");
  assert.equal(p.sale, "PIT-001");
  assert.equal(res.body.agent_id, signer.accountId);
  assert.ok(verifyEd25519(res.body.pass, res.body.sig_b64, signer.accountId));
});

test("wrong pow is refused", () => {
  const g = gate();
  const ch = g.challenge("alice.testnet", "0").body;
  const r = g.verify({ session_id: ch.session_id, pow_solution: "definitely-not", answer: "0" });
  assert.equal(r.body.error, "pow_failed");
});

test("sessions are one-shot and attempt-limited", () => {
  const g = gate();
  const ch = g.challenge("bob.testnet", "0").body;
  const pow = solve(ch.nonce);
  const ok = g.verify({ session_id: ch.session_id, pow_solution: pow, answer: "1" });
  assert.equal(ok.status, 200);
  assert.equal(g.verify({ session_id: ch.session_id, pow_solution: pow, answer: "0" }).body.error, "session_not_found");

  const ch2 = g.challenge("bob.testnet", "0").body;
  for (let i = 0; i < 5; i++) g.verify({ session_id: ch2.session_id, pow_solution: "x", answer: "0" });
  assert.equal(g.verify({ session_id: ch2.session_id, pow_solution: "x", answer: "0" }).body.error, "too_many_attempts");
});

test("a wrong answer consumes the solved challenge", () => {
  const g = gate();
  const ch = g.challenge("bob.testnet", "0").body;
  const pow = solve(ch.nonce);
  assert.equal(g.verify({ session_id: ch.session_id, pow_solution: pow, answer: "0" }).body.error, "challenge_failed");
  assert.equal(g.verify({ session_id: ch.session_id, pow_solution: pow, answer: "1" }).body.error, "session_not_found");
});

test("null and other invalid request bodies are rejected", () => {
  const g = gate();
  for (const body of [null, undefined, [], "hello", 1]) assert.equal(g.verify(body).body.error, "invalid_body");
});

test("session ids must be strings", () => {
  const g = gate();
  const ch = g.challenge("bob.testnet", "0").body;
  assert.equal(g.verify({ session_id: [ch.session_id], pow_solution: solve(ch.nonce), answer: "0" }).body.error, "invalid_body");
  assert.equal(g.verify({ session_id: ch.session_id, pow_solution: [], answer: "0" }).body.error, "invalid_body");
});

test("expired sessions are refused", () => {
  let t = 1_000_000;
  const g = gate(() => t);
  const ch = g.challenge("carol.testnet", "0").body;
  t += DEFAULT_POLICY.sessionTtlMs + 1;
  assert.equal(g.verify({ session_id: ch.session_id, pow_solution: solve(ch.nonce), answer: "0" }).body.error, "session_expired");
});

test("bad buyer / epoch are rejected; per-buyer session cap holds", () => {
  const g = gate();
  assert.equal(g.challenge("Not Valid!", "0").body.error, "invalid_buyer_account");
  assert.equal(g.challenge("ok.testnet", "9").body.error, "invalid_epoch");
  for (let i = 0; i < 3; i++) assert.equal(g.challenge("dave.testnet", "0").status, 200);
  assert.equal(g.challenge("dave.testnet", "0").body.error, "gate_busy");
});

test("one client can't exhaust the gate (per-client cap)", () => {
  const g = gate();
  for (let i = 0; i < 6; i++) assert.equal(g.challenge(`u${i}.testnet`, "0", "1.2.3.4").status, 200);
  assert.equal(g.challenge("u9.testnet", "0", "1.2.3.4").body.error, "too_many_open_challenges");
  assert.equal(g.challenge("u9.testnet", "0", "5.6.7.8").status, 200, "other clients unaffected");
});

test("launchpad: passes bind the requested coin's sale; junk sales are refused", () => {
  const g = gate();
  const ch = g.challenge("alice.testnet", "0", "9.9.9.9", "pit-doge").body;
  const res = g.verify({ session_id: ch.session_id, pow_solution: solve(ch.nonce), answer: "1" });
  assert.equal(JSON.parse(res.body.pass).sale, "PIT-DOGE");
  assert.equal(g.challenge("alice.testnet", "0", "9.9.9.9", "HUMAN-001").body.error, "invalid_sale");
  assert.equal(g.challenge("alice.testnet", "0", "9.9.9.9", "PIT-<script>").body.error, "invalid_sale");
});


test("missing and coercible epochs are not silently treated as epoch zero", () => {
  const g = gate();
  for (const epoch of [null, undefined, "", " ", "0.0", "0e0", [], 0]) assert.equal(g.challenge("alice.near", epoch).body.error, "invalid_epoch");
});

test("invalid NEAR separator placement is refused", () => {
  const g = gate();
  for (const buyer of [".alice", "alice-", "a..b", "a_-b", "a__b"]) assert.equal(g.challenge(buyer,"0").body.error,"invalid_buyer_account");
});


test("mainnet refuses a development signing identity before accessing keys", async () => {
  const { loadIdentity } = await import("../src/identity.mjs");
  await assert.rejects(() => loadIdentity({ GATE_IDENTITY:"dev-key", NEAR_NETWORK:"mainnet", AGENT_CONTRACT_ID:"registry.near" }), /dev-key is test-only/);
});
