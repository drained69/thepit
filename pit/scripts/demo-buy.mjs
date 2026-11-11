#!/usr/bin/env node
/**
 * Local/testnet demo of an early-access launch:
 *   1. a sniper account tries buy() with no pass   → PassRequired
 *   2. a buyer account gets a pass from the launch gate and buys  → minted
 *
 *   DEPLOYER_ID=… DEPLOYER_PRIVATE_KEY=… PIT_CONTRACT=… GATE_URL=… \
 *     node pit/scripts/demo-buy.mjs [near=2]
 *
 * Creates buyer.<deployer> and sniper.<deployer> if missing. The gate
 * challenge is auto-answered here because this is a scripted demo.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BN from "bn.js";
import { connect, KeyPair, keyStores, utils } from "near-api-js";

const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
// rpc.*.near.org no longer answers; FastNEAR's public RPC does.
const RPC = process.env.NEAR_RPC ?? (NETWORK === "sandbox" ? "http://localhost:3030" : `https://rpc.${NETWORK}.fastnear.com`);
const { DEPLOYER_ID, DEPLOYER_PRIVATE_KEY, PIT_CONTRACT } = process.env;
const GATE_URL = process.env.GATE_URL ?? "http://localhost:8788";
const spend = utils.format.parseNearAmount(process.argv[2] ?? "2");
const TGAS = new BN("60000000000000");

const keyStore = new keyStores.InMemoryKeyStore();
const key = KeyPair.fromString(DEPLOYER_PRIVATE_KEY);
const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore });
const deployer = await near.account(DEPLOYER_ID);
await keyStore.setKey(NETWORK, DEPLOYER_ID, key);

async function actor(name) {
  const id = `${name}.${DEPLOYER_ID}`;
  await keyStore.setKey(NETWORK, id, key);
  const a = await near.account(id);
  try { await a.state(); } catch { await deployer.createAccount(id, key.getPublicKey(), new BN(utils.format.parseNearAmount("10"))); }
  return a;
}
const panic = (e) => (/"(Pass\w+|LaunchNotStarted|NotInGatedPhase|PerBuyerCap|Slippage)"|panicked: (\w+)/.exec(JSON.stringify(e?.type ?? "") + String(e?.message ?? e)) ?? [])[0] ?? String(e?.message ?? e).slice(0, 160);

const sniper = await actor("sniper");
const buyer = await actor("buyer");

try {
  await sniper.functionCall({ contractId: PIT_CONTRACT, methodName: "buy", args: { min_tokens_out: "0" }, gas: TGAS, attachedDeposit: new BN(spend) });
  console.log("🤖 sniper buy(): went through (curve is open)");
} catch (e) {
  console.log(`🤖 sniper buy() with no pass → ${panic(e)}`);
}

// The gate signs passes for one sale; launchpad coins each have their own id.
const { launch } = await deployer.viewFunction({ contractId: PIT_CONTRACT, methodName: "launch_info", args: {} });
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pit-pass-")), "pass.json");
const gp = spawnSync(process.execPath, [path.join(import.meta.dirname, "get-pass.mjs"), buyer.accountId, process.env.EPOCH ?? "0", GATE_URL, out], {
  env: { ...process.env, PIT_AUTO_ANSWER: "1", ...(launch?.sale_id ? { SALE: launch.sale_id } : {}) },
  stdio: ["ignore", "ignore", "inherit"],
});
if (gp.status !== 0) process.exit(gp.status ?? 1);
const { pass, sig_b64, agent_id } = JSON.parse(fs.readFileSync(out, "utf8"));
// A Shade Agent pass is checked against the agent contract (cross-contract).
const [methodName, args, gas] = agent_id
  ? ["buy_with_agent_pass", { pass, sig_b64, agent_id, min_tokens_out: "0" }, new BN("120000000000000")]
  : ["buy_with_pass", { pass, sig_b64, min_tokens_out: "0" }, TGAS];
const tokens = async () => BigInt(await buyer.viewFunction({ contractId: PIT_CONTRACT, methodName: "ft_balance_of", args: { account_id: buyer.accountId } }));

try {
  await sniper.functionCall({ contractId: PIT_CONTRACT, methodName, args, gas, attachedDeposit: new BN(spend) });
  console.log("🤖 sniper with the buyer's pass: went through ⚠️");
} catch (e) {
  console.log(`🤖 sniper replays the buyer's pass → ${panic(e)}`);
}

const before = await tokens();
const res = await buyer.functionCall({ contractId: PIT_CONTRACT, methodName, args, gas, attachedDeposit: new BN(spend) });
const events = (res.receipts_outcome ?? [])
  .flatMap((r) => r.outcome.logs)
  .filter((l) => l.startsWith("EVENT_JSON:"))
  .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
const refund = events.find((e) => e.event === "agent_pass_refund_credited")?.data[0];
const got = (await tokens()) - before;
if (!refund && got === 0n) console.log("logs:", (res.receipts_outcome ?? []).flatMap((r) => r.outcome.logs), JSON.stringify(res.status));
if (refund) console.log(`🧑 deposit refunded (${refund.reason}): the signing agent isn't a valid, attested agent right now`);
else console.log(`🧑 ${buyer.accountId} bought ${(Number(got / 10n ** 12n) / 1e6).toLocaleString()} PIT with a ${agent_id ? `Shade agent (${agent_id.slice(0, 10)}…)` : "pinned-key"} pass`);
