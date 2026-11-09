import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createGate } from "../src/gate.mjs";
import { clientAddress, createHandler } from "../src/http.mjs";

function startGate(trustProxy = false) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const gate = createGate({
    saleId: "PIT-001", verifierName: "t", signerId: "ab".repeat(32), mode: "dev-key",
    sign: (b) => crypto.sign(null, b, privateKey).toString("base64"),
  });
  const server = http.createServer(createHandler({ gate, info: gate.info(), trustProxy }));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function raw(port, request) {
  return new Promise((resolve) => {
    let out = "";
    const s = net.connect(port, "127.0.0.1", () => s.write(request));
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => s.destroy(), 1000);
  });
}

test("a request target that URL can't parse gets a 400, and the gate stays up", async (t) => {
  const server = await startGate();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  for (const target of ["//", "//x", "http://["]) {
    const reply = await raw(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(reply, /^HTTP\/1\.1 4\d\d/, `target ${target} is answered, not a crash`);
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
});

test("oversized and malformed verify bodies are answered, not thrown", async (t) => {
  const server = await startGate();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const big = await fetch(`http://127.0.0.1:${port}/api/gate/verify`, { method: "POST", body: "x".repeat(10_000) }).catch(() => null);
  assert.ok(!big || big.status === 413);
  const bad = await fetch(`http://127.0.0.1:${port}/api/gate/verify`, { method: "POST", body: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});

test("behind a proxy the client address is the hop the proxy appended, not a forged one", () => {
  const req = (xff) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.1" } });
  assert.equal(clientAddress(req("6.6.6.6, 203.0.113.9"), true), "203.0.113.9");
  assert.equal(clientAddress(req("203.0.113.9"), true), "203.0.113.9");
  assert.equal(clientAddress(req("6.6.6.6, 203.0.113.9"), false), "10.0.0.1");
  assert.equal(clientAddress(req(""), true), "10.0.0.1");
});

test("rotating a forged X-Forwarded-For can't dodge the per-client cap", async (t) => {
  const server = await startGate(true);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/api/gate/challenge?buyer=bob${i}.near&epoch=0`, {
      headers: { "x-forwarded-for": `9.9.9.${i}, 203.0.113.9` },
    });
    limited = r.status === 429;
  }
  assert.ok(limited, "the proxy-appended address is what gets capped");
});
