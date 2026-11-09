/**
 * HTTP layer for the gate, separate from identity loading so it can be tested.
 * Every request is answered; nothing a client sends can throw out of the handler.
 */

const MAX_BODY = 4_096;

/**
 * The client address used for per-client limits. Behind a proxy
 * (TRUST_PROXY=1) the *last* X-Forwarded-For entry is the one the proxy
 * appended; earlier entries are whatever the client sent and can be forged.
 */
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** `eligible(buyer)` (optional, async) gates who may ask for a challenge. */
export function createHandler({ gate, info, trustProxy = false, eligible = null, log = () => {} }) {
  const send = (res, status, body) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
    });
    res.end(JSON.stringify(body));
  };

  return (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://gate");
      } catch {
        return send(res, 400, { error: "bad_request" });
      }
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, service: "pit-gate-agent", ts_ms: Date.now() });
      if (req.method === "GET" && url.pathname === "/api/info") return send(res, 200, info);
      if (req.method === "GET" && url.pathname === "/api/gate/challenge") {
        const buyer = String(url.searchParams.get("buyer") ?? "").trim().toLowerCase();
        const issue = () => {
          const r = gate.challenge(buyer, url.searchParams.get("epoch"), clientAddress(req, trustProxy), url.searchParams.get("sale"));
          send(res, r.status, r.body);
        };
        if (!eligible || !/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(buyer)) return issue();
        eligible(buyer).then((e) => {
          if (e.ok) return issue();
          send(res, e.retry ? 503 : 403, { error: e.reason, ...(e.min_balance_yocto ? { min_balance_yocto: e.min_balance_yocto } : {}) });
        }).catch((err) => {
          log(`eligibility failed: ${err?.message ?? err}`);
          send(res, 503, { error: "eligibility_unavailable" });
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/gate/verify") {
        let raw = "";
        let tooBig = false;
        req.on("data", (c) => {
          raw += c;
          if (raw.length > MAX_BODY && !tooBig) {
            tooBig = true;
            send(res, 413, { error: "body_too_large" });
            req.destroy();
          }
        });
        req.on("error", () => {});
        req.on("end", () => {
          if (tooBig) return;
          try {
            let body;
            try {
              body = JSON.parse(raw);
            } catch {
              return send(res, 400, { error: "bad_json" });
            }
            const r = gate.verify(body);
            send(res, r.status, r.body);
          } catch (e) {
            log(`verify failed: ${e?.message ?? e}`);
            send(res, 500, { error: "internal" });
          }
        });
        return;
      }
      send(res, 404, { error: "not_found" });
    } catch (e) {
      log(`request failed: ${e?.message ?? e}`);
      send(res, 500, { error: "internal" });
    }
  };
}
