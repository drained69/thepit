/**
 * TEST ONLY — a stand-in for NEAR AI Cloud's verifiable-inference endpoints,
 * following docs.near.ai/cloud/verification: it signs
 * "<sha256(request)>:<sha256(response)>" (gateway) or
 * "<model>:<sha256(request)>:<sha256(response)>" (provider_tee) with Ed25519
 * over the exact body bytes, and reports the key in an attestation report.
 */
import crypto from "node:crypto";
import http from "node:http";

export function startMockNearAI({ kind = "gateway", lagMisses = 0, tamper = false, port = 0 } = {}) {
  let privateKey, signingAddress;
  const rotateKey = () => {
    const kp = crypto.generateKeyPairSync("ed25519");
    privateKey = kp.privateKey;
    signingAddress = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    return signingAddress;
  };
  rotateKey();
  const sigs = new Map();
  const misses = new Map();
  let n = 0;
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = JSON.parse(body.toString());
        const id = `chatcmpl-mock-${++n}`;
        const out = Buffer.from(JSON.stringify({
          id, object: "chat.completion", model: payload.model,
          choices: [{ index: 0, message: { role: "assistant", content: `Mock thought #${n}: the pit is warm today.` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 14 },
        }));
        const reqH = sha(body), resH = sha(out);
        const text = kind === "provider_tee" ? `${payload.model}:${reqH}:${resH}` : `${reqH}:${resH}`;
        const signed = tamper ? `${reqH}:${"0".repeat(64)}` : text;
        sigs.set(id, { text, signature: crypto.sign(null, Buffer.from(signed), privateKey).toString("hex"), signing_address: signingAddress, signing_algo: "ed25519", signature_kind: kind });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(out);
      }
      const sig = /^\/v1\/signature\/(.+)$/.exec(url.pathname);
      if (sig) {
        const id = decodeURIComponent(sig[1]);
        const m = misses.get(id) ?? 0;
        if (m < lagMisses) { misses.set(id, m + 1); res.writeHead(404); return res.end("{}"); }
        const s = sigs.get(id);
        res.writeHead(s ? 200 : 404, { "content-type": "application/json" });
        return res.end(JSON.stringify(s ?? {}));
      }
      if (url.pathname === "/v1/attestation/report") {
        res.writeHead(200, { "content-type": "application/json" });
        // Real shape: each TEE's key leads its quote's report_data (key ‖ nonce).
        const att = { signing_address: signingAddress, signing_algo: "ed25519", report_data: signingAddress + "00".repeat(32), intel_quote: "mock" };
        return res.end(JSON.stringify({ gateway_attestation: att, model_attestations: [{ ...att, model_name: url.searchParams.get("model") }] }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({
    base: `http://localhost:${server.address().port}/v1`,
    get signingAddress() { return signingAddress; },
    /** Simulate NEAR AI rotating its TEE signing key. */
    rotateKey,
    close: () => server.close(),
  })));
}
