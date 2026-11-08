/**
 * Human gate logic — a port of tee-gate (policy.rs / state.rs) with the same
 * HTTP contract: odd-one-out challenge + browser proof-of-work → a pass signed
 * byte-exact over its JSON. No I/O here; the signer is injected.
 */
import crypto from "node:crypto";

const CATEGORIES = [
  ["food", ["🍩", "🧅", "🍇", "🍗", "🧇", "🥮", "🍫", "🥐"]],
  ["animal", ["🐢", "🦊", "🐙", "🦩", "🐿️", "🪱", "🐝", "🐍"]],
  ["tool", ["🔧", "🪛", "🔩", "🪚", "🧰", "🧲", "🛠️", "⛏️"]],
  ["travel", ["🚂", "🛴", "🛩️", "⛵", "🚠", "🚟", "🛶"]],
];

const MAX_SESSIONS = 10_000;
const MAX_SESSIONS_PER_BUYER = 3;
// One client can't fill the global session table and lock everyone out.
const MAX_SESSIONS_PER_CLIENT = 6;
const BUYER_RE = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/** Launchpad coins use sale ids like PIT-DOGE (see the factory). */
const SALE_RE = /^PIT-[A-Z0-9]{2,10}$/;

export const DEFAULT_POLICY = {
  powTarget: (2n ** 64n - 1n) >> 18n, // ~2^18 hashes: instant for a human, not free for a farm
  passCapTokens: 250_000n,
  passTtlMs: 5 * 60_000,
  sessionTtlMs: 15 * 60_000,
  maxAttempts: 5,
};

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

export function generateChallenge(seed = crypto.randomBytes(16)) {
  const ruleIdx = seed[0] % CATEGORIES.length;
  const oddIdx = seed[1] % CATEGORIES.length;
  const [majorWord, major] = CATEGORIES[ruleIdx];
  const oddPool = CATEGORIES[oddIdx === ruleIdx ? (ruleIdx + 1) % CATEGORIES.length : oddIdx][1];
  // Three distinct majority items, then one slot replaced by the odd item.
  const picks = [];
  for (let i = 0; picks.length < 3; i++) {
    const item = major[(seed[2 + (i % 5)] + i) % major.length];
    if (!picks.includes(item)) picks.push(item);
  }
  const oddPos = seed[7] % 3;
  picks[oddPos] = oddPool[seed[8] % oddPool.length];
  return {
    answer: String(oddPos),
    view: {
      prompt: "One of these is not like the others. Tap it.",
      hint: `Two are ${majorWord} — the odd one is not.`,
      options: picks,
    },
  };
}

export function checkPow(nonce, solution, target) {
  return sha256(`${nonce}:${solution}`).readBigUInt64BE(0) < target;
}

/**
 * @param {object} o
 * @param {string} o.saleId
 * @param {string} o.verifierName
 * @param {string} o.signerId      agent account id = hex of the signing public key
 * @param {string} o.mode          "shade-tee" | "shade-local" | "dev-key"
 * @param {(bytes: Buffer) => string} o.sign   returns base64 Ed25519 signature
 */
export function createGate({ saleId, verifierName, signerId, mode, sign, policy = DEFAULT_POLICY, now = Date.now, makeChallenge = generateChallenge }) {
  const sessions = new Map();

  function prune() {
    const t = now();
    for (const [id, s] of sessions) if (t > s.createdMs + policy.sessionTtlMs) sessions.delete(id);
  }

  return {
    info() {
      return {
        service: "pit-gate-agent",
        mode,
        sale_id: saleId,
        verifier_name: verifierName,
        signing_address: signerId,
        agent_id: signerId,
        pow_target: policy.powTarget.toString(),
        pass_cap_tokens: policy.passCapTokens.toString(),
        pass_ttl_ms: policy.passTtlMs,
      };
    },

    /**
     * `client` identifies the caller (IP) for the per-client session cap.
     * `saleRaw` picks the launchpad coin (e.g. PIT-DOGE); defaults to saleId.
     */
    challenge(buyerRaw, epochRaw, client = "unknown", saleRaw) {
      const buyer = String(buyerRaw ?? "").trim().toLowerCase();
      const epoch = typeof epochRaw === "string" && /^[0-7]$/.test(epochRaw) ? Number(epochRaw) : NaN;
      const sale = saleRaw ? String(saleRaw).toUpperCase() : saleId;
      if (sale !== saleId && !SALE_RE.test(sale)) return { status: 400, body: { error: "invalid_sale" } };
      if (!BUYER_RE.test(buyer)) return { status: 400, body: { error: "invalid_buyer_account" } };
      if (!Number.isInteger(epoch) || epoch < 0 || epoch >= 8) return { status: 400, body: { error: "invalid_epoch" } };
      prune();
      const open = [...sessions.values()];
      if (open.filter((s) => s.client === client).length >= MAX_SESSIONS_PER_CLIENT) {
        return { status: 429, body: { error: "too_many_open_challenges", retry_after_seconds: 60 } };
      }
      if (sessions.size >= MAX_SESSIONS || open.filter((s) => s.buyer === buyer).length >= MAX_SESSIONS_PER_BUYER) {
        return { status: 503, body: { error: "gate_busy", retry_after_seconds: 10 } };
      }
      const sessionId = crypto.randomBytes(16).toString("hex");
      const nonce = sha256(crypto.randomBytes(16)).toString("hex");
      const challenge = makeChallenge();
      sessions.set(sessionId, { buyer, epoch, sale, nonce, challenge, client, attempts: 0, createdMs: now() });
      return {
        status: 200,
        body: {
          session_id: sessionId,
          nonce,
          pow_target: policy.powTarget.toString(),
          pow_rule: "find a string X such that sha256(nonce + ':' + X) < target; send X as pow_solution",
          challenge: challenge.view,
          pass_ttl_ms: policy.passTtlMs,
        },
      };
    },

    verify(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "invalid_body" } };
      const { session_id, pow_solution, answer } = body;
      if (typeof session_id !== "string" || typeof pow_solution !== "string" || typeof answer !== "string") return { status: 400, body: { error: "invalid_body" } };
      if (!/^[0-9a-f]{32}$/.test(session_id) || pow_solution.length > 256 || answer.length > 16) return { status: 400, body: { error: "invalid_body" } };
      const sessionId = session_id;
      const s = sessions.get(sessionId);
      if (!s) return { status: 400, body: { error: "session_not_found" } };
      if (now() > s.createdMs + policy.sessionTtlMs) {
        sessions.delete(sessionId);
        return { status: 400, body: { error: "session_expired" } };
      }
      if (++s.attempts > policy.maxAttempts) {
        sessions.delete(sessionId);
        return { status: 400, body: { error: "too_many_attempts" } };
      }
      if (!checkPow(s.nonce, String(pow_solution ?? ""), policy.powTarget)) return { status: 400, body: { error: "pow_failed" } };
      // A solved proof permits one answer. A wrong guess consumes the session.
      if (String(answer ?? "").trim() !== s.challenge.answer) {
        sessions.delete(sessionId);
        return { status: 400, body: { error: "challenge_failed" } };
      }

      // Field order matches tee-gate's PassToken; the contract verifies these exact bytes.
      const pass = JSON.stringify({
        v: 1,
        sale: s.sale,
        kind: "human",
        buyer: s.buyer,
        epoch: s.epoch,
        max_amount: policy.passCapTokens.toString(),
        nonce: s.nonce,
        expires_at_ms: now() + policy.passTtlMs,
      });
      const sig_b64 = sign(Buffer.from(pass));
      sessions.delete(sessionId); // one-shot
      return {
        status: 200,
        body: {
          pass,
          pass_nonce: s.nonce,
          sig_b64,
          signing_algo: "ed25519",
          agent_id: signerId,
          verifier: { name: verifierName, signing_address: signerId, signing_algo: "ed25519", mode },
        },
      };
    },
  };
}
