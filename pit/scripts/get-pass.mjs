#!/usr/bin/env node
/**
 * Get a human pass from tee-gate for a gated epoch of The Pit.
 *
 *   node pit/scripts/get-pass.mjs <buyer> [epoch=0] [gate=http://localhost:8788] [out.json]
 *
 * Solves the proof-of-work, then asks YOU to answer the odd-one-out challenge
 * on the terminal (that's the human part). Prints the near CLI command for
 * buy_with_pass and optionally writes {pass, sig_b64, verifier} to out.json.
 * Set PIT_AUTO_ANSWER=1 only for automated tests.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline/promises";

const [buyer, epoch = "0", gate = "http://localhost:8788", outFile] = process.argv.slice(2);
if (!buyer) {
  console.error("usage: get-pass.mjs <buyer> [epoch] [gate] [out.json]");
  process.exit(1);
}
const get = async (p) => (await fetch(gate + p)).json();
const post = async (p, body) =>
  (await fetch(gate + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const sha = (s) => crypto.createHash("sha256").update(s).digest();

const info = await get("/api/info");
console.error(`gate: ${info.sale_id} · mode ${info.mode} · signer ${info.signing_address}`);

let solved = null;
const auto = process.env.PIT_AUTO_ANSWER === "1";
// Every solved challenge permits one guess. Auto mode is for local tests only;
// each failed guess obtains a new challenge and solves its proof again.
for (let attempt = 0; attempt < (auto ? 30 : 1); attempt++) {
  const ch = await get(`/api/gate/challenge?buyer=${encodeURIComponent(buyer)}&epoch=${encodeURIComponent(epoch)}`);
  if (!ch.session_id) throw new Error(`challenge refused: ${JSON.stringify(ch)}`);
  let pow = "";
  const target = BigInt(ch.pow_target);
  for (let i = 0; ; i++) {
    if (sha(`${ch.nonce}:${i}`).readBigUInt64BE() < target) { pow = String(i); break; }
  }
  console.error(`proof-of-work solved (${pow})`);
  let a = String(attempt % 3);
  if (!auto) {
    console.error(`\n${ch.challenge.hint}\n${ch.challenge.options.map((o, i) => `  [${i}] ${o}`).join("\n")}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    a = (await rl.question("your answer: ")).trim();
    rl.close();
  }
  const r = await post("/api/gate/verify", { session_id: ch.session_id, pow_solution: pow, answer: a });
  if (r.pass) { solved = r; break; }
  if (!auto || r.error !== "challenge_failed") throw new Error(`gate said no: ${JSON.stringify(r)}`);
}
if (!solved) throw new Error("no pass issued");

// A Shade Agent gate names itself (agent_id = its implicit account = its key).
const agentId = solved.agent_id ?? null;
const out = { pass: solved.pass, sig_b64: solved.sig_b64, agent_id: agentId, verifier: solved.verifier };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
const [method, gas, args] = agentId
  ? ["buy_with_agent_pass", "120 Tgas", { pass: solved.pass, sig_b64: solved.sig_b64, agent_id: agentId, min_tokens_out: "0" }]
  : ["buy_with_pass", "50 Tgas", { pass: solved.pass, sig_b64: solved.sig_b64, min_tokens_out: "0" }];
console.error(`\n✅ pass issued${agentId ? ` by Shade agent ${agentId.slice(0, 12)}…` : ""}: ${solved.pass}\n`);
console.log(`near contract call-function as-transaction CONTRACT ${method} json-args '${JSON.stringify(args)}' prepaid-gas '${gas}' attached-deposit '1 NEAR' sign-as ${buyer} network-config testnet sign-with-keychain send`);
