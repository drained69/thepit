/**
 * NEAR plumbing: wallet-selector (MyNearWallet), view calls via RPC, and
 * action builders. VITE_NEAR_NETWORK=mainnet|testnet picks the network.
 */
import {
  setupWalletSelector,
  type WalletSelector,
  type Wallet,
  type AccountState,
} from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { providers } from "near-api-js";
import type { AccessKeyList, CodeResult, RpcQueryRequest } from "near-api-js/lib/providers/provider";
import { Buffer } from "buffer";

import { NETWORK, PIT_CONTRACT, PIT_FACTORY } from "../config";
import { decodeSuccessValue, receiptLogs } from "./transaction-result";

const YOCTO_PER_NEAR = 10n ** 24n;

export { NETWORK };
// rpc.*.near.org no longer answers; FastNEAR's public RPC does.
const RPC_TESTNET = (import.meta.env.VITE_NEAR_RPC as string) || `https://rpc.${NETWORK}.fastnear.com`;
/** Explorer links for accounts and transactions. */
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const tg = (n: number | bigint) => BigInt(n) * 1_000_000_000_000n;

let _selector: WalletSelector | null = null;
let _modal: WalletSelectorModal | null = null;
let _selectorPending: Promise<WalletSelector> | null = null;

export async function selector(): Promise<WalletSelector> {
  if (_selector) return _selector;
  if (!_selectorPending) _selectorPending = initializeSelector().finally(() => { _selectorPending = null; });
  return _selectorPending;
}

async function initializeSelector(): Promise<WalletSelector> {
  const initialized = await setupWalletSelector({
    // Explicit network so the selector uses the working RPC, not its near.org default.
    network: {
      networkId: NETWORK,
      nodeUrl: RPC_TESTNET,
      helperUrl: `https://helper.${NETWORK}.near.org`,
      explorerUrl: EXPLORER,
      indexerUrl: `https://api.${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io`,
    },
    modules: [setupMyNearWallet()],
  });
  // Sign-in is scoped to the launchpad factory (or the single coin) this deployment serves.
  const walletContract =
    (import.meta.env.VITE_WALLET_CONTRACT as string) ||
    PIT_FACTORY ||
    PIT_CONTRACT ||
    "";
  _modal = setupModal(initialized, { contractId: walletContract });
  _selector = initialized;
  return initialized;
}

export async function connect(): Promise<void> {
  const s = await selector();
  if (!_modal) throw new Error("selector not ready");
  _modal.show();
  void s; // noop to satisfy lint
}

export async function wallet(): Promise<Wallet> {
  // The selector owns the active wallet. A cached Wallet can become stale on
  // sign-out or when the user selects a different wallet implementation.
  return (await selector()).wallet();
}

export async function getAccount(): Promise<AccountState | null> {
  const s = await selector();
  return s.isSignedIn() ? s.store.getState().accounts[0] ?? null : null;
}

export function subscribeAccount(callback: (accountId: string | null) => void): () => void {
  let subscription: { unsubscribe: () => void } | null = null;
  let disposed = false;
  void selector().then((s) => {
    if (disposed) return;
    subscription = s.store.observable.subscribe((state) => {
      if (!disposed) callback(state.accounts[0]?.accountId ?? null);
    });
  }).catch(() => { if (!disposed) callback(null); });
  return () => { disposed = true; subscription?.unsubscribe(); };
}

export async function signOut(): Promise<void> {
  const w = await wallet();
  await w.signOut();
}

// ————————————————————————————————— views —————————————————————————————————

const provider = new providers.JsonRpcProvider({ url: RPC_TESTNET });

/** Bound read requests so unavailable RPCs surface an error before the next poll. */
async function queryView<T>(params: RpcQueryRequest): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetch(RPC_TESTNET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}`);
    const { result, error } = await response.json();
    if (!result) throw new Error(error?.data?.error_message ?? error?.message ?? "Missing NEAR RPC result");
    return result as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("NEAR RPC request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function accessKeyCount(accountId: string): Promise<number> {
  const result = await queryView<AccessKeyList>({
    request_type: "view_access_key_list",
    account_id: accountId,
    finality: "final",
  });
  return result.keys.length;
}

/** RPC `call_function` returns the value as an array of bytes. */
export async function viewMethod<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const result = await queryView<CodeResult>({
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    finality: "optimistic",
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}

// ————————————————————————————— actions ————————————————————————————————

export async function sendFunctionCall(
  receiver: string,
  method: string,
  args: any = {},
  gasTGas: number | string = 200,
  depositYocto = "0",
  expectedSigner?: string
): Promise<{ transactionHash: string; result: unknown; logs: string[] }> {
  const w = await wallet();
  const accountId = (await getAccount())?.accountId;
  if (!accountId) throw new Error("Connect a wallet before sending a transaction");
  if (expectedSigner && expectedSigner !== accountId) throw new Error("Wallet changed. Review the connected account before trying again.");
  if (!(await w.getAccounts()).some(account => account.accountId === accountId)) throw new Error("Selected wallet does not own the current signer");
  const res = await w.signAndSendTransaction({ signerId: accountId, receiverId: receiver, actions: [{
    type: "FunctionCall", params: { methodName: method, args, gas: tg(BigInt(gasTGas)).toString(), deposit: depositYocto },
  }] });
  const first: any = Array.isArray(res) ? res[0] : res;
  const hash = first?.transaction?.hash ?? first?.transaction_outcome?.id ?? first?.transactionHash;
  if (!hash) throw new Error("Wallet did not return a transaction result. Check your wallet before retrying.");
  let out;
  try { out = await provider.txStatus(hash, accountId); }
  catch { throw new Error(`Transaction ${hash} was submitted, but its status is unavailable. Check your wallet before retrying.`); }
  const status: any = out?.status;
  if (status && typeof status === "object" && "Failure" in status) throw new Error(failureMessage(status.Failure));
  if (!status || typeof status !== "object" || !("SuccessValue" in status)) {
    throw new Error(`Transaction ${hash} has not reached a confirmed final result. Check your wallet before retrying.`);
  }
  return { transactionHash: hash, result: decodeSuccessValue(status.SuccessValue), logs: receiptLogs(out) };
}

function failureMessage(failure: any): string {
  const f = failure?.FunctionCallError?.ExecutionError ?? failure;
  if (typeof f === "string") return f;
  return (f?.SmartContractExecutionError as string)
    ?? f?.HostError
    ?? f?.MethodNotFound
    ?? JSON.stringify(f);
}

/** Parse user-entered NEAR without rounding; rejects more than 24 decimals. */
export function parseNearAmount(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{0,24})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt((fraction + "0".repeat(24)).slice(0, 24));
}
