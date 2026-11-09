/**
 * NEAR plumbing for the brain: env loading, RPC view calls, and a keeper that
 * can only call The Pit's permissionless methods.
 */
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import { connect, KeyPair, keyStores } from "near-api-js";

export const YOCTO = 10n ** 24n;
const KEEPER_GAS = new BN("250000000000000"); // 250 Tgas

/** The only methods the keeper ever calls. None move funds anywhere new. */
export const KEEPER_METHODS = ["rebalance", "process_queue", "harvest", "retry_harvest", "withdraw_refund", "record_thought"];

/** Contract panics that just mean "nothing to do right now". */
const BENIGN = ["PoolOpInFlight", "NothingToHarvest", "HarvestPending"];

export function loadEnv(file = path.join(import.meta.dirname, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([\w-]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export function toNear(yocto, digits = 2) {
  const y = BigInt(yocto);
  const scale = 10n ** BigInt(digits);
  const v = (y * scale) / YOCTO;
  return digits === 0 ? `${v}` : `${v / scale}.${(v % scale).toString().padStart(digits, "0")}`;
}

export async function view(rpc, contractId, method, args = {}) {
  const res = await fetch(rpc, {
    signal: AbortSignal.timeout(20000),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "pit",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) {
    throw new Error(`view ${method}: ${JSON.stringify(body.error ?? body.result.error)}`);
  }
  return JSON.parse(Buffer.from(body.result.result).toString());
}

function panicText(err) {
  const s = `${err?.message ?? ""} ${JSON.stringify(err?.transaction_outcome ?? err?.type ?? "")}`;
  const hit = /Smart contract panicked: ([^"\\]+)/.exec(s) ?? /Panicked: ([^"\\]+)/.exec(s);
  return hit ? hit[1].trim() : s.slice(0, 200);
}

export { KEEPER_GAS };

/** NEP-297 events the contract logged anywhere in this transaction. */
function eventsOf(outcome) {
  return (outcome?.receipts_outcome ?? [])
    .flatMap((r) => r.outcome?.logs ?? [])
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try { return JSON.parse(l.slice("EVENT_JSON:".length)); } catch { return null; }
    })
    .filter((e) => e?.standard === "pit");
}

/**
 * `allow(contractId)` decides which contracts the keeper may poke — the single
 * coin, or any coin the launchpad factory created (`*.factory`).
 */
export async function makeKeeper({ network, rpc, accountId, privateKey, allow, log = () => {} }) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(network, accountId, KeyPair.fromString(privateKey));
  const near = await connect({ networkId: network, nodeUrl: rpc, keyStore });
  const account = await near.account(accountId);
  const canPayDeposits = await keyCanAttachDeposits(near, network, accountId, privateKey, log);

  /** Returns { ok, value, events } on success, { ok: false, benign, error } otherwise. */
  /** `depositYocto` pays storage (record_thought); excess is refunded by the contract. */
  async function call(contractId, method, args = {}, depositYocto = "0") {
    if (!KEEPER_METHODS.includes(method)) throw new Error(`keeper refuses ${method}`);
    if (!allow(contractId)) throw new Error(`keeper refuses contract ${contractId}`);
    // NEAR rejects any deposit from a function-call access key: don't send a doomed tx.
    if (depositYocto !== "0" && !canPayDeposits) return { ok: false, benign: true, skipped: true, error: "keeper key can't attach deposits" };
    try {
      const outcome = await account.functionCall({
        contractId,
        methodName: method,
        args,
        gas: KEEPER_GAS,
        attachedDeposit: new BN(depositYocto),
      });
      const raw = outcome?.status?.SuccessValue;
      const value = raw ? JSON.parse(Buffer.from(raw, "base64").toString() || "null") : null;
      return { ok: true, value, events: eventsOf(outcome) };
    } catch (err) {
      const error = panicText(err);
      return { ok: false, benign: BENIGN.some((b) => error.includes(b)), error };
    }
  }
  call.canPayDeposits = canPayDeposits;
  return call;
}

/**
 * Single-coin deploys give the keeper a function-call key (gas only); a
 * launchpad keeper is its own account with a full-access key.
 */
async function keyCanAttachDeposits(near, network, accountId, privateKey, log) {
  try {
    const publicKey = KeyPair.fromString(privateKey).getPublicKey().toString();
    const key = await near.connection.provider.query({ request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    if (key.permission === "FullAccess") return true;
    log("keeper key is function-call only: refund withdrawals and Proof-of-Thought recording are off (they need a deposit). Use a full-access keeper account to enable them.");
    return false;
  } catch {
    return true; // Unknown: try, and let the chain answer.
  }
}
