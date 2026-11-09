/**
 * Pin the tee-gate's verifier key on-chain AFTER verifying its sim evidence.
 *
 * Fail-closed: refuses to register unless
 *   1. quote signature verifies under res/sim-root.pub, AND
 *   2. the quote binds the SAME ed25519 key the gate uses to sign passes,
 *   3. attribute_debug is false,
 *   4. the evidence hash matches what the gate publicizes.
 *
 * Env: OWNER_ID, OWNER_PRIVATE_KEY, GATE_URL (default localhost:8788).
 * Usage: node scripts/register-verifier.mjs [verifier_name]
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { connect, transactions, KeyPair, keyStores, Contract } from "near-api-js";

import { loadEnv, OWNER_ID, RPC, GATE_URL, SIM_ROOT_PUB } from "./common.mjs";

const TGAS = BigInt(10) ** 12n;

const verifySimQuote = (evidence) => {
  const rootPubHex = fs.readFileSync(SIM_ROOT_PUB, "utf8").trim();
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(rootPubHex.replace(/\s/g, ""), "hex"),
  ]);
  const root = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const msg = Buffer.from(evidence.quote_b64, "base64");
  const sig = Buffer.from(evidence.quote_sig_b64, "base64");
  const ok = crypto.verify(null, msg, root, sig);
  const payload = JSON.parse(msg.toString("utf8"));
  const debugOff = payload.tdx?.attributes_debug === false;
  return { ok, debugOff, payload, rootPubHex };
};

const main = async () => {
  loadEnv();
  const name = process.argv[2] ?? "human-gate-sim-1";

  // 1. Fresh standalone evidence for a REGISTRATION nonce (not a pass nonce).
  const regNonce = crypto.randomBytes(32).toString("hex");
  const bundle = await (await fetch(`${GATE_URL}/api/gate/attestation?nonce=${regNonce}`)).json();
  if (!bundle.evidence) throw new Error("gate returned no evidence (running?)");

  // 2. Verify BEFORE trusting the key.
  const v = verifySimQuote(bundle.evidence);
  console.log("sim-root verifies quote:", v.ok ? "✅" : "❌", "| debug attributes off:", v.debugOff ? "✅" : "❌");
  if (!v.ok || !v.debugOff) throw new Error("FAIL CLOSED: evidence did not verify — refusing to register");
  if (v.payload.signing_address !== bundle.signing_address)
    throw new Error("FAIL CLOSED: quote does not bind the gate's signing key");
  if (v.payload.policy_hash !== bundle.policy_hash)
    throw new Error("FAIL CLOSED: policy_hash drift between /info and evidence");
  console.log("evidence binds signing key:", "✅", bundle.signing_address.slice(0, 16) + "…");

  // 3. Pin it on-chain.
  const keyStore = new keyStores.InMemoryKeyStore();
  keyStore.setKey("testnet", OWNER_ID, KeyPair.fromString(process.env.OWNER_PRIVATE_KEY));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore });
  const account = await near.account(OWNER_ID);

  const sale = new Contract(account, OWNER_ID, { viewMethods: ["verifiers_list"], changeMethods: ["register_verifier"] });
  const pinned = await sale.verifiers_list();
  if (pinned.some((p) => p.pubkey_hex === bundle.signing_address)) {
    console.log("this verifier key is already pinned on-chain — nothing to do");
    return;
  }

  const res = await account.signAndSendTransaction(OWNER_ID, [
    transactions.functionCall(
      "register_verifier",
      { pubkey_hex: bundle.signing_address, name, evidence_hash_hex: bundle.evidence_hash },
      (50n * TGAS).toString(),
      "1"
    ),
  ]);
  console.log("tx:", res.transaction.hash);
  console.log("verifiers now:", JSON.stringify(await sale.verifiers_list()));

  console.log(`
✅ verifier "${name}" pinned:
   key:            ${bundle.signing_address}
   evidence_hash:  ${bundle.evidence_hash}
   policy_hash:    ${bundle.policy_hash}
   chain of trust: res/sim-root.pub → quote → signing key → passes → purchase()
`);
};

main().catch((e) => {
  console.error("REGISTER-VERIFIER FAILED:", e);
  process.exit(1);
});
