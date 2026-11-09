/**
 * The brain's public read API: feed, blobs, health, rNEAR market.
 * Every request is answered; nothing a client sends can throw out of the handler
 * (the brain is also the keeper, so a crash would stop rebalancing and payouts).
 */
export function createFeedHandler({ feed, feedMax, getBlob, rnearMarket, health, log = () => {} }) {
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" };
  const json = (res, status, body) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://brain");
      } catch {
        return json(res, 400, { error: "bad_request" });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed" });
      if (url.pathname === "/api/rnear/market") {
        rnearMarket().then((data) => json(res, 200, data)).catch(() => json(res, 503, { error: "rnear_market_unavailable" }));
        return;
      }
      if (url.pathname === "/api/feed") {
        // ?coin=doge for one coin; otherwise everything, newest first.
        const coin = url.searchParams.get("coin");
        return json(res, 200, { items: (coin ? feed().filter((f) => f.coin === coin) : feed()).slice(0, feedMax) });
      }
      // Raw request/response bodies and attestation reports, by sha256.
      const blob = /^\/api\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
      if (blob) {
        const buf = getBlob(blob[1]);
        if (!buf) return json(res, 404, { error: "not_found" });
        res.writeHead(200, { ...headers, "content-type": "application/octet-stream" });
        return res.end(buf);
      }
      if (url.pathname === "/api/health") return json(res, 200, health());
      json(res, 404, { error: "not_found" });
    } catch (e) {
      log(`feed request failed: ${e?.message ?? e}`);
      json(res, 500, { error: "internal" });
    }
  };
}
