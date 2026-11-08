#!/usr/bin/env node
/**
 * Owner actions on an agent registry (the TEST-ONLY mock, or the real Shade
 * agent contract in local mode — same method names).
 *
 *   node pit/scripts/registry-admin.mjs whitelist <agent_account_id>
 *   node pit/scripts/registry-admin.mjs remove    <agent_account_id>
 *   node pit/scripts/registry-admin.mjs status    <agent_account_id>
 *
 * Env: DEPLOYER_ID / DEPLOYER_PRIVATE_KEY (registry owner), AGENT_REGISTRY,
 *      NEAR_NETWORK, NEAR_RPC
 */
import BN from "bn.js";
import { connect, KeyPair, keyStores } from "near-api-js";

const [cmd, agent] = process.argv.slice(2);
const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const RPC = process.env.NEAR_RPC ?? (NETWORK === "sandbox" ? "http://localhost:3030" : `https://rpc.${NETWORK}.fastnear.com`);
const { DEPLOYER_ID, DEPLOYER_PRIVATE_KEY, AGENT_REGISTRY } = process.env;
if (!["whitelist", "remove", "status"].includes(cmd) || !agent || !AGENT_REGISTRY) {
  console.error("usage: registry-admin.mjs whitelist|remove|status <agent_account_id>  (needs AGENT_REGISTRY)");
  process.exit(1);
}
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(NETWORK, DEPLOYER_ID, KeyPair.fromString(DEPLOYER_PRIVATE_KEY));
const owner = await (await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore })).account(DEPLOYER_ID);

if (cmd !== "status") {
  const methodName = cmd === "whitelist" ? "whitelist_agent_for_local" : "remove_agent";
  await owner.functionCall({ contractId: AGENT_REGISTRY, methodName, args: { account_id: agent }, gas: new BN("30000000000000") });
}
const view = await owner.viewFunction({ contractId: AGENT_REGISTRY, methodName: "get_agent", args: { account_id: agent } });
console.log(`${agent.slice(0, 16)}… on ${AGENT_REGISTRY}: ${view ? JSON.stringify(view.validity) : "not registered"}`);
