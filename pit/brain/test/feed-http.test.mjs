import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createFeedHandler } from "../feed-http.mjs";

async function start(overrides = {}) {
  const feed = [{ kind: "thought", text: "hi", coin: "doge" }, { kind: "buy", text: "b", coin: "frog" }];
  const server = http.createServer(createFeedHandler({
    feed: () => feed, feedMax: 50, getBlob: (h) => (h === "a".repeat(64) ? Buffer.from("blob") : null),
    rnearMarket: async () => ({ apy: 1 }), health: () => ({ ok: true }), ...overrides,
  }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
const stop = (t, server) => t.after(() => { server.closeAllConnections(); server.close(); });

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

test("an unparseable request target is answered and the keeper's process survives", async (t) => {
  const server = await start(); stop(t, server);
  const { port } = server.address();
  const reply = await raw(port, "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});

test("a failing dependency becomes a 500, not a crash", async (t) => {
  const server = await start({ health: () => { throw new Error("boom"); } }); stop(t, server);
  const { port } = server.address();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 500);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/feed`)).status, 200);
});

test("feed filtering, blobs and method limits", async (t) => {
  const server = await start(); stop(t, server);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(`${base}/api/feed?coin=doge`)).json()).items.map((i) => i.coin), ["doge"]);
  assert.equal(await (await fetch(`${base}/api/blob/${"a".repeat(64)}`)).text(), "blob");
  assert.equal((await fetch(`${base}/api/blob/${"b".repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/blob/../../etc`)).status, 404);
  assert.equal((await fetch(`${base}/api/feed`, { method: "POST", body: "{}" })).status, 405);
  assert.equal((await fetch(`${base}/api/rnear/market`)).status, 200);
});
