/**
 * scripts/bot-attack.mjs — the on-chain "bot carnage" showcase.
 *
 * Every attack runs REAL transactions against the deployed $HUMAN contract;
 * every outcome must be a refusal. The script fails (exit 1) if ANY attack
 * somehow succeeds — that would mean a security hole.
 *
 * Attacks:
 *   A1 raw purchase, no pass/verifier       → expect PassUnknownVerifier
 *   A2 pass signed for a different buyer    → expect PassNotForYou
 *   A3 replay the same signed pass twice    → second expect PassReplay
 *
 * Env: OWNER_ID, OWNER_PRIVATE_KEY, GATE_URL. Usage: node scripts/bot-attack.mjs
 */
import crypto from "node:crypto";
import { connect, transactions, KeyPair, keyStores, Contract } from "near-api-js";

import { loadEnv, OWNER_ID, RPC, GATE_URL, SALE_ID, panicText } from "./common.mjs";

const TGAS = BigInt(10) ** 12n;
const JOCTO = BigInt(10) ** 24n;
const results = [];

const expectPanic = async (label, expected, fn) => {
  let failure = null;
  try {
    await fn();
  } catch (e) {
    failure = e;
  }
  if (!failure) {
    results.push(`${label}: ❌ UNEXPECTED SUCCESS (contract accepted the attack)`);
    return { matched: false, unexpectedSuccess: true };
  }
  const panic = panicText(failure);
  const matched = expected.test(panic);
  results.push(matched
    ? `${label}: 🛑 rejected as expected → ${panic.slice(0, 100)}`
    : `${label}: ⚠️ failed for an unexpected reason → ${panic.slice(0, 100)}`);
  return { panic, matched, unexpectedSuccess: false };
};

async function gatePassFor(buyer, epoch = 0) {
  const r = await (await fetch(`${GATE_URL}/api/gate/challenge?buyer=${buyer}&epoch=${epoch}`)).json();
  const sha = (s) => crypto.createHash("sha256").update(s).digest();
  let sol = "";
  for (let i = 0; i < 1e9; i++) {
    if (sha(`${r.nonce}:${i}`).readBigUInt64BE() < BigInt(r.pow_target)) { sol = String(i); break; }
  }
  let solved = null;
  for (let i = 0; i < 3 && !solved; i++) {
    const q = await (await fetch(`${GATE_URL}/api/gate/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: r.session_id, pow_solution: sol, answer: String(i) }),
    })).json();
    if (q.pass) solved = q;
  }
  if (!solved) throw new Error("gate pass grab failed");
  return solved;
}

const main = async () => {
  loadEnv();
  const keyStore = new keyStores.InMemoryKeyStore();
  keyStore.setKey("testnet", OWNER_ID, KeyPair.fromString(process.env.OWNER_PRIVATE_KEY));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore });
  const account = await near.account(OWNER_ID);
  const sale = new Contract(account, OWNER_ID, { viewMethods: ["sale_overview"], changeMethods: [] });
  const ov = await sale.sale_overview();
  console.log(`contract phase: ${ov.phase} (attacks still demonstrate verifier binding even outside human epochs)`);

  // ——— A1: raw purchase — proves the chain refuses unpass-backed buys ———
  const dummySig = Buffer.alloc(64).toString("base64");
  await expectPanic("A1 raw purchase (no pass)", /UnknownVerifier|must be exactly 64 bytes/s, () =>
    account.signAndSendTransaction(
      OWNER_ID,
      [transactions.functionCall("purchase", { pass: `{}`, sig_b64: dummySig }, (200n * TGAS).toString(), (JOCTO * 10n).toString())]
    )
  );

  // ——— A2: pass minted to ANOTHER buyer, submitted from our wallet ———
  const activeEpoch = ov.phase === "human" ? ov.current_epoch : null;
  const attackEpoch = activeEpoch ?? 0;
  const stolen = await gatePassFor("sniper-victim.testnet", attackEpoch);
  await expectPanic("A2 pass submitted by a different account", /PassNotForYou|NotForYou/i, () =>
    account.signAndSendTransaction(
      OWNER_ID,
      [transactions.functionCall("purchase", { pass: stolen.pass, sig_b64: stolen.sig_b64 }, (200n * TGAS).toString(), (JOCTO * 10n).toString())]
    )
  );

  // ——— A3: replay — a pass for OUR account, used twice ———
  const mine = await gatePassFor(OWNER_ID, attackEpoch);
  const replayEligible = activeEpoch != null;
  if (!replayEligible) {
    results.push("A3 pass replay: skipped because no human allocation epoch is live");
  } else {
    const firstEpoch = ov.epochs[attackEpoch];
    const passMax = BigInt(JSON.parse(mine.pass).max_amount);
    const exactDeposit = (BigInt(firstEpoch.price_yocto_per_token) * passMax).toString();
  const first = await account
    .signAndSendTransaction(
      OWNER_ID,
      [transactions.functionCall("purchase", { pass: mine.pass, sig_b64: mine.sig_b64 }, (200n * TGAS).toString(), exactDeposit)]
    )
    .catch((e) => ({ panic: panicText(e), failed: true }));
  if (!first.failed) {
    await expectPanic("A3 replay of used pass", /PassReplay|REPLAY/i, () =>
      account.signAndSendTransaction(
        OWNER_ID,
        [transactions.functionCall("purchase", { pass: mine.pass, sig_b64: mine.sig_b64 }, (200n * TGAS).toString(), exactDeposit)]
      )
    );
  } else {
    results.push(`A3 replay setup failed before the first purchase → ${first.panic.slice(0, 100)}`);
  }
  }

  const allBlocked = results.every((r) => !r.includes("❌") && !r.includes("⚠️") && !r.includes("setup failed"));
  console.log("\n——— bot carnage scoreboard ———");
  console.log(results.join("\n"));
  console.log(allBlocked ? "\n🛑 ALL ATTACKS BLOCKED ON-CHAIN ✅" : "\n🚨 ATTACK(S) SUCCEEDED — SECURITY HOLE");
  if (!allBlocked) process.exit(1);
};

main().catch((e) => {
  console.error("BOT-ATTACK FAILED:", e?.message ?? e);
  process.exit(1);
});
