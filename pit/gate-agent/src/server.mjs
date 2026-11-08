#!/usr/bin/env node
/**
 * The Pit human gate as a Shade Agent. Same HTTP API as tee-gate:
 *   GET  /api/health · GET /api/info
 *   GET  /api/gate/challenge?buyer=&epoch=&sale=   (sale: launchpad coin, e.g. PIT-DOGE)
 *   POST /api/gate/verify {session_id, pow_solution, answer}
 *
 * Env: AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY,
 *      SALE_ID (PIT-001), VERIFIER_NAME, PORT (3000), GATE_IDENTITY (shade|dev-key),
 *      NEAR_NETWORK, NEAR_RPC, LOCAL_DERIVATION_SECRET, GATE_DEV_KEY_FILE
 */
import http from "node:http";
import { createGate } from "./gate.mjs";
import { loadIdentity } from "./identity.mjs";

const env = process.env;
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const identity = await loadIdentity(env, log);
const gate = createGate({
  saleId: env.SALE_ID ?? "PIT-001",
  verifierName: env.VERIFIER_NAME ?? "pit-gate-agent",
  signerId: identity.accountId,
  mode: identity.mode,
  sign: identity.sign,
});
const info = { ...gate.info(), agent_contract_id: env.AGENT_CONTRACT_ID };

const MAX_BODY = 4_096;
const send = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://gate");
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, service: "pit-gate-agent", ts_ms: Date.now() });
    if (req.method === "GET" && url.pathname === "/api/info") return send(res, 200, info);
    if (req.method === "GET" && url.pathname === "/api/gate/challenge") {
      // Behind a reverse proxy set TRUST_PROXY=1 so the real client IP is used.
      const fwd = env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
      const r = gate.challenge(url.searchParams.get("buyer"), url.searchParams.get("epoch"), fwd || req.socket.remoteAddress, url.searchParams.get("sale"));
      return send(res, r.status, r.body);
    }
    if (req.method === "POST" && url.pathname === "/api/gate/verify") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > MAX_BODY) req.destroy();
      });
      req.on("end", () => {
        let body;
        try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "bad_json" }); }
        const r = gate.verify(body);
        return send(res, r.status, r.body);
      });
      return;
    }
    send(res, 404, { error: "not_found" });
  })
  .listen(Number(env.PORT ?? 3000), () => log(`gate up on :${env.PORT ?? 3000} · ${info.mode} · sale ${info.sale_id} · agent ${info.agent_id}`));
