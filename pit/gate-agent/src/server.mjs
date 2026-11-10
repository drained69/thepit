#!/usr/bin/env node
/**
 * The Pit launch gate as a Shade Agent. HTTP API:
 *   GET  /api/health · GET /api/info
 *   GET  /api/gate/challenge?buyer=&epoch=&sale=   (sale: launchpad coin, e.g. PIT-DOGE)
 *   POST /api/gate/verify {session_id, pow_solution, answer}
 *
 * Env: AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY,
 *      SALE_ID (PIT-001), VERIFIER_NAME, PORT (3000), GATE_IDENTITY (shade|dev-key),
 *      NEAR_NETWORK, NEAR_RPC, LOCAL_DERIVATION_SECRET, GATE_DEV_KEY_FILE
 */
import http from "node:http";
import { createGate } from "./gate.mjs";
import { createEligibility, parseNear, rpcViewAccount } from "./eligibility.mjs";
import { createHandler } from "./http.mjs";
import { loadIdentity } from "./identity.mjs";

const env = process.env;
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const identity = await loadIdentity(env, log);
const gate = createGate({
  saleId: env.SALE_ID ?? "PIT-001",
  verifierName: env.VERIFIER_NAME ?? "pit-gate-agent",
  signerId: identity.accountId,
  mode: identity.mode,
  sign: identity.sign,
});
// Buyer wallets must exist and hold GATE_MIN_BALANCE_NEAR (default 1 on
// mainnet, 0 elsewhere): a capital cost per wallet a bot farm runs.
const network = env.NEAR_NETWORK ?? "testnet";
const minBalanceYocto = parseNear(env.GATE_MIN_BALANCE_NEAR ?? (network === "mainnet" ? "1" : "0"));
const rpc = env.NEAR_RPC ?? (network === "sandbox" ? "http://localhost:3030" : `https://rpc.${network}.fastnear.com`);
const eligible = createEligibility({ viewAccount: rpcViewAccount(rpc), minBalanceYocto });
const info = { ...gate.info(), agent_contract_id: env.AGENT_CONTRACT_ID, min_buyer_balance_yocto: minBalanceYocto.toString() };

http
  .createServer(createHandler({ gate, info, trustProxy: env.TRUST_PROXY === "1", eligible, log }))
  .listen(Number(env.PORT ?? 3000), () => log(`gate up on :${env.PORT ?? 3000} · ${info.mode} · sale ${info.sale_id} · agent ${info.agent_id}`));
