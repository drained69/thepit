const ORIGIN = 'https://api.rhea.finance';
const PREFIX = '/api/cross-chain';
const SOURCES = new Set(['1', '8453', '42161']);
const GETS = new Set(['/get_chain_prices', '/api/swap/supported_to_tokens', '/api/swap/order-status']);
const POSTS = new Set(['/api/v2/swap/quote', '/api/v2/swap/swap', '/api/swap/report', '/api/swap/order-submit']);
const TOKEN_TTL_MS = 60_000;
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function validateRoute(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Expected a JSON object');
  if (path === '/api/v2/swap/quote' || path === '/api/v2/swap/swap') {
    if (!SOURCES.has(String(body.fromChain)) || body.toChain !== 'near') throw new RequestError(400, 'Unsupported route');
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.sender || '')) throw new RequestError(400, 'Invalid sender');
    if (!/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(body.recipient || '')) throw new RequestError(400, 'Invalid NEAR recipient');
    if (typeof body.amountIn !== 'string' || !/^[1-9][0-9]{0,35}$/.test(body.amountIn)) throw new RequestError(400, 'Invalid amount');
    if (!Number.isInteger(body.slippage) || body.slippage < 1 || body.slippage > 100) throw new RequestError(400, 'Slippage must be 1–100 bps');
  } else if (path === '/api/swap/order-submit') {
    // RHEA SDK SwapOrderSubmitRequestRaw: forward nothing else under our key.
    onlyStrings(body, { router: 256, quoteId: 256, signature: 2048, signingScheme: 64 }, ['router', 'quoteId', 'signature']);
  } else if (path === '/api/swap/report') {
    // The app's fundingReportRequest (RHEA SwapReportRequestRaw).
    onlyStrings(body, { sender: 42, recipient: 64, from_hash: 512, from_token: 512, to_token: 512, deposit_address: 512,
      from_chain: 16, to_chain: 8, amount_in: 36, estimated_out: 80, router: 256, tx_type: 64, swapId: 512, is_cross_chain: 0 },
      ['sender', 'recipient', 'from_hash', 'from_token', 'to_token', 'from_chain', 'to_chain', 'amount_in', 'estimated_out', 'router', 'tx_type']);
    if (!SOURCES.has(body.from_chain) || body.to_chain !== 'near' || body.is_cross_chain !== true) throw new RequestError(400, 'Unsupported route');
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.sender)) throw new RequestError(400, 'Invalid sender');
    if (!/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(body.recipient)) throw new RequestError(400, 'Invalid NEAR recipient');
    if (!/^[1-9][0-9]{0,35}$/.test(body.amount_in) || !/^[0-9]{1,80}$/.test(body.estimated_out)) throw new RequestError(400, 'Invalid amount');
  }
}

/** Only the listed keys, each a bounded string (limit 0 = must be boolean). */
function onlyStrings(body, limits, required) {
  for (const [key, value] of Object.entries(body)) {
    const limit = limits[key];
    if (limit === undefined) throw new RequestError(400, `Unexpected field ${key.slice(0, 32)}`);
    if (limit === 0 ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > limit) throw new RequestError(400, `Invalid ${key}`);
  }
  for (const key of required) if (!body[key]) throw new RequestError(400, `Missing ${key}`);
}

/** Behind a proxy (TRUST_PROXY=1) use the hop it appended; earlier X-Forwarded-For entries are client-supplied. */
export function clientAddress(req, trustProxy = process.env.TRUST_PROXY === '1') {
  if (trustProxy) {
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
async function responseJson(response) {
  // Bound decoded bytes, including compressed upstream responses.
  if (!response.body) return response.json();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new RequestError(502, 'Funding provider response is too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function validateQuery(path, params) {
  const allowed = path === '/api/swap/order-status'
    ? new Set(['recordId', 'orderId', 'txHash', 'router', 'chainId']) : new Set(['chain']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1 || params.get(key).length > 256) throw new RequestError(400, 'Invalid query');
  }
  if (path === '/get_chain_prices' && !SOURCES.has(params.get('chain'))) throw new RequestError(400, 'Unsupported chain');
  if (path === '/api/swap/supported_to_tokens' && params.get('chain') !== '900001') throw new RequestError(400, 'Unsupported chain');
  if (path === '/api/swap/order-status' && !['recordId', 'orderId', 'txHash'].some(k => params.get(k))) throw new RequestError(400, 'Missing order reference');
}
export function createRheaProxy({ apiKey = () => process.env.RHEA_API_KEY, fetchImpl = fetch, now = Date.now } = {}) {
  const buckets = new Map(), cache = new Map(), pending = new Map();
  let lastSweep = 0, inFlight = 0;
  async function upstream(path, query, method, body, idempotency) {
    if (inFlight >= 8) throw new RequestError(503, 'Funding service is busy. Try again shortly.');
    inFlight++;
    try {
      const response = await fetchImpl(ORIGIN + path + query, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}`,
          ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await responseJson(response);
      if (!response.ok || data?.code !== 0) throw new RequestError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        'RHEA route unavailable. Refresh or try another asset.');
      return data;
    } finally { inFlight--; }
  }
  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { return false; }
    if (!url.pathname.startsWith(PREFIX + '/')) return false;
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 429 ? {'retry-after':'60'} : {}) });
      res.end(JSON.stringify(data));
    };
    const path = url.pathname.slice(PREFIX.length);
    if (path === '/config' && req.method === 'GET') { reply(200, { enabled: Boolean(apiKey()), sources: [...SOURCES], destination: 'near' }); return true; }
    if (!apiKey()) { reply(503, {code:503, msg:'Cross-chain funding is not configured'}); return true; }
    // Per client: behind Railway set TRUST_PROXY=1, or every visitor shares one bucket.
    const ip = clientAddress(req), time = now();
    if (time - lastSweep >= 60_000) {
      for (const [key, bucket] of buckets) if (time - bucket.start >= 60_000) buckets.delete(key);
      lastSweep = time;
    }
    const previous = buckets.get(ip);
    const bucket = previous && time - previous.start < 60_000 ? previous : { start: time, count: 0 };
    if (!previous && buckets.size >= 10_000) { reply(429, {code:429,msg:'Try again shortly'}); return true; }
    buckets.set(ip, bucket);
    if (++bucket.count > 120) { reply(429, {code:429,msg:'Too many requests'}); return true; }
    if (!(req.method === 'GET' && GETS.has(path)) && !(req.method === 'POST' && POSTS.has(path))) { reply(404, {code:404,msg:'Unknown endpoint'}); return true; }
    try {
      if (url.search.length > 2048) throw new RequestError(400, 'Query too long');
      let body;
      if (req.method === 'POST') {
        if (url.search) throw new RequestError(400, 'Unexpected query parameters');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(400, 'JSON required');
        if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new RequestError(413, 'Request too large');
        const origin = req.headers.origin;
        if (origin) {
          let parsed;
          try { parsed = new URL(origin); } catch { throw new RequestError(403, 'Cross-origin requests are not allowed'); }
          if (parsed.host !== req.headers.host || !['http:', 'https:'].includes(parsed.protocol)) throw new RequestError(403, 'Cross-origin requests are not allowed');
        }
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) throw new RequestError(413, 'Request too large');
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
        validateRoute(path, body);
      } else validateQuery(path, url.searchParams);
      const idempotency = req.headers['idempotency-key'];
      if (idempotency != null && (typeof idempotency !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(idempotency))) throw new RequestError(400, 'Invalid idempotency key');
      // Public directional token lists have only four possible cache keys.
      const key = req.method === 'GET' && path !== '/api/swap/order-status' ? path + '?' + url.searchParams.toString() : null;
      let data;
      if (key && cache.get(key)?.expires > time) data = cache.get(key).data;
      else if (key && pending.has(key)) data = await pending.get(key);
      else {
        const request = upstream(path, url.search, req.method, body, idempotency);
        if (key) pending.set(key, request);
        try {
          data = await request;
          if (key) cache.set(key, {data, expires:now() + TOKEN_TTL_MS});
        } finally { if (key) pending.delete(key); }
      }
      reply(200, data);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : error instanceof SyntaxError ? 400 : 502;
      reply(status, {code:status, msg: error instanceof RequestError ? error.message : status === 400 ? 'Invalid JSON' : 'Funding provider could not be reached'});
    }
    return true;
  };
}
