import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createEligibility, parseNear } from "../src/eligibility.mjs";
import { createGate } from "../src/gate.mjs";
import { createHandler } from "../src/http.mjs";

const NEAR = 10n ** 24n;
const accounts = { "rich.near": { amount: (5n * NEAR).toString() }, "poor.near": { amount: (NEAR / 10n).toString() } };
const viewAccount = async (id) => {
  if (id === "flaky.near") throw new Error("rpc down");
  return accounts[id] ?? null;
};

test("parseNear", () => {
  assert.equal(parseNear("1"), NEAR);
  assert.equal(parseNear("0.5"), NEAR / 2n);
  assert.equal(parseNear(""), 0n);
  assert.throws(() => parseNear("-1"));
});

test("a wallet must exist and hold the minimum balance", async () => {
  const eligible = createEligibility({ viewAccount, minBalanceYocto: NEAR });
  assert.deepEqual(await eligible("rich.near"), { ok: true });
  assert.equal((await eligible("poor.near")).reason, "buyer_balance_too_low");
  assert.equal((await eligible("ghost.near")).reason, "buyer_account_not_found");
  const flaky = await eligible("flaky.near");
  assert.equal(flaky.reason, "eligibility_unavailable");
  assert.equal(flaky.retry, true);
});

test("results are cached, RPC failures are not, and lookups are bounded", async () => {
  let calls = 0;
  let t = 0;
  const eligible = createEligibility({ viewAccount: async (id) => { calls++; return viewAccount(id); }, minBalanceYocto: NEAR, now: () => t });
  await eligible("rich.near"); await eligible("rich.near");
  assert.equal(calls, 1);
  t = 61_000; await eligible("rich.near");
  assert.equal(calls, 2);
  const slow = createEligibility({ viewAccount: () => new Promise(() => {}), minBalanceYocto: 0n, maxInFlight: 2 });
  slow("a.near"); slow("b.near");
  assert.equal((await slow("c.near")).reason, "gate_busy");
});

test("the HTTP gate refuses challenges to ineligible wallets and serves eligible ones", async (t) => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const gate = createGate({ saleId: "PIT-001", verifierName: "t", signerId: "ab".repeat(32), mode: "dev-key", sign: (b) => crypto.sign(null, b, privateKey).toString("base64") });
  const eligible = createEligibility({ viewAccount, minBalanceYocto: NEAR });
  const server = http.createServer(createHandler({ gate, info: gate.info(), eligible }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/gate/challenge?epoch=0&buyer=`;
  const poor = await fetch(base + "poor.near");
  assert.equal(poor.status, 403);
  assert.equal((await poor.json()).error, "buyer_balance_too_low");
  assert.equal((await fetch(base + "ghost.near")).status, 403);
  assert.equal((await fetch(base + "flaky.near")).status, 503);
  const ok = await fetch(base + "rich.near");
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.challenge.hint, undefined, "no hint naming the answer's category");
  assert.equal(body.challenge.options.length, 3);
});
