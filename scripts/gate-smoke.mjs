// tee-gate smoke test: challenge → PoW → verify → local ed25519 check → attestation.
// Usage: node scripts/gate-smoke.mjs [buyer] [port]
import crypto from "node:crypto";
import fs from "node:fs";

const buyer = process.argv[2] ?? "human.testnet";
const port = process.argv[3] ?? "8788";
const base = `http://localhost:${port}`;
const ROOTS = new Set();

// Pin the sim root (demo trust root).
for (const p of ["res/sim-root.pub", "../res/sim-root.pub"]) {
  if (fs.existsSync(p)) ROOTS.add(fs.readFileSync(p, "utf8").trim());
}
if (ROOTS.size === 0) {
  console.error("!! no res/sim-root.pub found — run tee-gate with --export-root res");
  process.exit(1);
}

const get = async (path) => (await fetch(base + path)).json();
const post = async (path, body) =>
  (await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json();

const sha = (s) => crypto.createHash("sha256").update(s).digest();

// ——— 1. challenge ———
const ch = await get(`/api/gate/challenge?buyer=${buyer}&epoch=0`);
console.log("challenge:", ch.challenge, "pow_target:", ch.pow_target);
if (!ch.session_id) throw new Error("no session");

// ——— 2. PoW ———
let pow = "";
for (let i = 0; i < 2e9; i++) {
  const x = String(i);
  if (sha(`${ch.nonce}:${x}`).readBigUInt64BE() < BigInt(ch.pow_target)) { pow = x; break; }
}
console.log("pow solution:", pow);

// ——— 3. verify (answer = the odd position) ———
// Answer honestly: options[ch.odd] — the UI shows three items; for the smoke
// test we pick the one the hint excludes (ch.challenge.options[challenge.answer is hidden] —
// so answer by position found via the hint rule: pick index of odd_pos in view.options.
// The view hides the answer; the simulation picks option matching rule via hint text.
// For smoke: try each index.
let solved = null;
const opts = ch.challenge.options;
console.log("options:", opts.join(" "), "| hint:", ch.challenge.hint);
for (let i = 0; i < 3 && !solved; i++) {
  const r = await post("/api/gate/verify", { session_id: ch.session_id, pow_solution: pow, answer: String(i) });
  if (r.pass) solved = r;
}
if (!solved) throw new Error("no correct answer found (unexpected)");
console.log("PASS:", solved.pass);
console.log("verifier:", solved.verifier);

// ——— 4. local signature check (exactly what the contract will do on-chain) ———
const rawPub = Buffer.from(solved.verifier.signing_address, "hex");
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
const sig = Buffer.from(solved.sig_b64, "base64");
const ok = crypto.verify(null, Buffer.from(solved.pass), key, sig);
console.log("ed25519 verify:", ok ? "✅ VALID" : "❌ BAD");
if (!ok) throw new Error("signature invalid");

// ——— 5. attestation evidence + sim-root check ———
const at = await get(`/api/gate/attestation?nonce=${ch.nonce}`);
const ev = at.evidence;
console.log("evidence mode:", ev.mode);
const quote = Buffer.from(ev.quote_b64, "base64");
const qsig = Buffer.from(ev.quote_sig_b64, "base64");
const rootKeys = [...ROOTS].map((r) =>
  crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(r, "hex")]),
    format: "der",
    type: "spki",
  })
);
const eok = rootKeys.some((k) => crypto.verify(null, quote, k, qsig));
console.log("sim-root verifies evidence:", eok ? "✅ VALID" : "❌ BAD");
if (!eok) throw new Error("sim evidence not verifiable");
console.log("evidence binds gate key:", ev.signing_address === solved.verifier.signing_address ? "✅ MATCH" : "❌ MISMATCH");
console.log("evidence_hash:", at.evidence_hash);
console.log("\nSMOKE OK — buyer can hand pass+sig_b64 to the contract's purchase()");
