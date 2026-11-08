/**
 * Who signs passes.
 *
 *   shade    — @neardefi/shade-agent-js. Inside a Phala/dstack TEE the key is
 *              generated from enclave entropy and register() submits a TDX
 *              attestation the agent contract verifies (measurements, PPID,
 *              report data = this account). Outside a TEE it's Shade's local
 *              mode: the contract owner must whitelist the account.
 *   dev-key  — no Shade library: a local Ed25519 key as an implicit account,
 *              registered with a requires_tee=false registry. Unattested;
 *              for local development and tests only.
 *
 * Either way the signer's NEAR account id is the hex of its public key, which
 * is what The Pit's buy_with_agent_pass checks against the agent contract.
 */
import fs from "node:fs";
import BN from "bn.js";
import { connect, KeyPair, keyStores, utils } from "near-api-js";
import { randomNearSecret, signerFromNearSecret } from "./keys.mjs";

const REREGISTER_MS = 6 * 24 * 60 * 60 * 1000; // attestations expire (7 days by default)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadIdentity(env, log = console.log) {
  const mode = env.GATE_IDENTITY ?? "shade";
  if (!env.AGENT_CONTRACT_ID) throw new Error("AGENT_CONTRACT_ID is required");
  if (mode === "shade") return shadeIdentity(env, log);
  if (mode === "dev-key") {
    if (env.NEAR_NETWORK === "mainnet") throw new Error("Mainnet gate requires an attested Shade identity; dev-key is test-only");
    return devKeyIdentity(env, log);
  }
  throw new Error(`GATE_IDENTITY must be "shade" or "dev-key" (got ${mode})`);
}

async function shadeIdentity(env, log) {
  const { ShadeClient } = await import("@neardefi/shade-agent-js");
  const { JsonRpcProvider } = await import("@near-js/providers");
  const networkId = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const client = await ShadeClient.create({
    networkId,
    // The library's default RPC (rpc.*.near.org) no longer answers.
    rpc: new JsonRpcProvider({ url: env.NEAR_RPC ?? `https://rpc.${networkId}.fastnear.com` }),
    agentContractId: env.AGENT_CONTRACT_ID,
    sponsor: { accountId: env.SPONSOR_ACCOUNT_ID, privateKey: env.SPONSOR_PRIVATE_KEY },
    // Only used outside a TEE (Shade local mode); ignored inside one.
    derivationPath: env.LOCAL_DERIVATION_SECRET || undefined,
  });
  const accountId = client.accountId();
  log(`agent account: ${accountId}`);
  const info = await client.view({ methodName: "get_contract_info", args: {} });
  if (networkId === "mainnet" && info.requires_tee !== true) throw new Error("Mainnet gate registry must require TEE attestation");
  if ((await client.balance()) < 0.2) await client.fund(0.5);

  for (;;) {
    try {
      const whitelisted = await client.isWhitelisted(); // null when the contract requires a TEE
      if ((whitelisted === null || whitelisted) && (await client.register())) break;
      log("waiting: whitelist this account on the agent contract (shade whitelist)");
    } catch (e) {
      log(`register failed: ${e?.message ?? e}`);
    }
    await sleep(10_000);
  }
  setInterval(() => client.register().then(() => log("re-registered")).catch((e) => log(`re-register failed: ${e?.message ?? e}`)), REREGISTER_MS);

  // The account key signs passes. It never leaves this process; inside a TEE
  // it never leaves the enclave. Do not log or return it.
  const signer = signerFromNearSecret(client.getPrivateKeys({ acknowledgeRisk: true })[0]);
  if (signer.accountId !== accountId) throw new Error("agent key does not match agent account");
  return { accountId, sign: signer.sign, mode: info.requires_tee ? "shade-tee" : "shade-local" };
}

async function devKeyIdentity(env, log) {
  const file = env.GATE_DEV_KEY_FILE;
  let secret = env.GATE_DEV_SECRET;
  if (!secret && file && fs.existsSync(file)) secret = fs.readFileSync(file, "utf8").trim();
  if (!secret) {
    secret = randomNearSecret();
    if (file) fs.writeFileSync(file, secret + "\n", { mode: 0o600 });
  }
  const signer = signerFromNearSecret(secret);
  const network = env.NEAR_NETWORK ?? "testnet";
  const rpc = env.NEAR_RPC ?? (network === "sandbox" ? "http://localhost:3030" : `https://rpc.${network}.fastnear.com`);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(network, signer.accountId, KeyPair.fromString(signer.nearSecret));
  await keyStore.setKey(network, env.SPONSOR_ACCOUNT_ID, KeyPair.fromString(env.SPONSOR_PRIVATE_KEY));
  const near = await connect({ networkId: network, nodeUrl: rpc, keyStore });
  const agent = await near.account(signer.accountId);
  log(`agent account (dev-key, NOT attested): ${signer.accountId}`);

  // Fund the implicit account (a transfer creates it).
  try {
    await agent.state();
  } catch {
    const sponsor = await near.account(env.SPONSOR_ACCOUNT_ID);
    await sponsor.sendMoney(signer.accountId, new BN(utils.format.parseNearAmount("0.2")));
  }
  for (;;) {
    try {
      await agent.functionCall({
        contractId: env.AGENT_CONTRACT_ID,
        methodName: "register_agent",
        args: { attestation: { quote: [], collateral: {}, tcb_info: {} } },
        gas: new BN("30000000000000"),
        attachedDeposit: new BN(utils.format.parseNearAmount("0.005")),
      });
      break;
    } catch (e) {
      log(`waiting: whitelist ${signer.accountId} on ${env.AGENT_CONTRACT_ID} (${String(e?.message ?? e).slice(0, 80)})`);
      await sleep(5_000);
    }
  }
  return { accountId: signer.accountId, sign: signer.sign, mode: "dev-key" };
}
