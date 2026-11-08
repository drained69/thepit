/**
 * Deploy the $HUMAN sale contract to testnet and initialize the demo epochs.
 *
 * Env (scripts/.env):
 *   OWNER_ID          — account that owns the contract & treasury; the wasm
 *                       is deployed TO this account (no extra account step).
 *   OWNER_PRIVATE_KEY — `ed25519:<base64>` owner signing key.
 *
 * Runbooks: docs/05-demo-runbook.md. Usage: node scripts/deploy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { connect, transactions, Contract, KeyPair, keyStores } from "near-api-js";

import {
  loadEnv, OWNER_ID, RPC, SALE_ID, WASM_PATH, REPO_ROOT,
  demoEpochs, TOKEN_TOTAL_SUPPLY_ATOMS,
} from "./common.mjs";

const TGAS = BigInt(10) ** 12n;

const main = async () => {
  loadEnv();
  if (!OWNER_ID || !process.env.OWNER_PRIVATE_KEY) {
    throw new Error("set OWNER_ID and OWNER_PRIVATE_KEY in scripts/.env");
  }
  const build = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "build-contract.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("contract WASM build failed");
  const keyStore = new keyStores.InMemoryKeyStore();
  keyStore.setKey("testnet", OWNER_ID, KeyPair.fromString(process.env.OWNER_PRIVATE_KEY));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore });
  const account = (await near.account(OWNER_ID));

  const code = fs.readFileSync(WASM_PATH);
  const { epochs, open_cfg } = demoEpochs();
  const now = Date.now();
  if (epochs.some((e) => e.starts_at_ms <= now)) throw new Error("epoch schedule drifted — rerun the script");

  const initArgs = {
    owner: OWNER_ID,
    sale_id: SALE_ID,
    epochs,
    open_cfg,
    total_supply: TOKEN_TOTAL_SUPPLY_ATOMS,
    treasury_percent: 70,
    token_name: "HUMAN",
    token_symbol: "HUMAN",
    token_decimals: 24,
    token_icon: null,
    metadata_reference: null,
  };
  console.log("trojan: deploy+init batch on", OWNER_ID);
  console.log("epochs:", JSON.stringify(epochs, null, 1).replace(/\n\s+/g, " "));

  const res = await account.signAndSendTransaction(OWNER_ID, [
    transactions.deployContract(code),
    transactions.functionCall("new", initArgs, (600n * TGAS).toString(), "1"),
  ]);
  console.log("tx:", res.transaction.hash, res.transaction_outcome.outcome.status);

  const sale = new Contract(account, OWNER_ID, {
    viewMethods: ["sale_overview", "buyer_state", "storage_balance_bounds"],
    changeMethods: [],
  });
  const overview = await sale.sale_overview();
  console.log(JSON.stringify(overview, null, 2));

  // Practical convenience: the treasury was pre-minted to `owner`; give owner
  // an account entry so ft_balance_of works out of the box.
  const storageBounds = await sale.storage_balance_bounds();
  await account.signAndSendTransaction(OWNER_ID, [
    transactions.functionCall("storage_deposit", { account_id: OWNER_ID, registration_only: true }, (30n * TGAS).toString(), storageBounds.min),
  ]);
  console.log("treasury account registered with", storageBounds.min, "yocto storage");

  console.log(`
✅ sale live at ${OWNER_ID}
   phase now:   ${overview.phase}
   epoch 0 starts ${new Date(epochs[0].starts_at_ms).toISOString()}
   next: node scripts/register-verifier.mjs   (requires tee-gate running)
`);
};

main().catch((e) => {
  console.error("DEPLOY FAILED:", e);
  process.exit(1);
});
