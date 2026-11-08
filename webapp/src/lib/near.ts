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
import { providers, utils } from "near-api-js";

import { SALE_CONTRACT, YOCTO_PER_NEAR } from "./config";

export const NETWORK: "mainnet" | "testnet" = import.meta.env.VITE_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
// rpc.*.near.org no longer answers; FastNEAR's public RPC does.
const RPC_TESTNET = (import.meta.env.VITE_NEAR_RPC as string) || `https://rpc.${NETWORK}.fastnear.com`;
/** Explorer links for accounts and transactions. */
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export { SALE_CONTRACT };

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
  // Sign-in is scoped to the contract this deployment serves (The Pit or $HUMAN).
  const walletContract =
    (import.meta.env.VITE_WALLET_CONTRACT as string) ||
    (import.meta.env.VITE_PIT_FACTORY as string) ||
    (import.meta.env.VITE_PIT_CONTRACT as string) ||
    SALE_CONTRACT;
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

/** RPC `call_function` returns the value as an array of bytes. */
function decode<T>(result: any): T {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result as number[])));
}

export async function viewMethod<T>(contract: string, method: string, args: any = {}): Promise<T> {
  const result = await provider.query({
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
    finality: "optimistic",
  });
  return decode<T>(result);
}

// ———————————————————————————— shape types ————————————————————————————————

export interface SaleOverview {
  sale_id: string;
  owner: string;
  paused: boolean;
  finalized: boolean;
  phase: "pre" | "human" | "open" | "finalized";
  current_epoch: number | null;
  total_supply_atoms: string;
  minted_supply_atoms: string;
  sale_supply_atoms: string;
  sold_atoms: string;
  unminted_sale_atoms: string;
  now_ms: number;
  epochs: {
    starts_at_ms: number;
    ends_at_ms: number;
    price_yocto_per_token: string;
    per_buyer_max_tokens: string;
    cap_tokens: string;
    sold_tokens: string;
    sold_atoms: string;
  }[];
  open?: { ends_at_ms: number; price_yocto_per_token: string; per_buyer_max_tokens: string; cap_tokens: string; sold_tokens: string; sold_atoms: string };
  verifier_count: number;
}

export interface BuyerState {
  balance: string;
  human_bought_total: string;
  per_phase: { phase: "human" | "open"; epoch: number | null; bought: string }[];
}

// ————————————————————————————— actions ————————————————————————————————

export async function sendFunctionCall(
  receiver: string,
  method: string,
  args: any = {},
  gasTGas: number | string = 200,
  depositYocto = "0"
): Promise<{ transactionHash: string }> {
  const w = await wallet();
  const accountId = (await getAccount())?.accountId;
  if (!accountId) throw new Error("Connect a wallet before sending a transaction");
  const res = await w.signAndSendTransaction({ receiverId: receiver, actions: [{
    type: "FunctionCall", params: { methodName: method, args, gas: tg(BigInt(gasTGas)).toString(), deposit: depositYocto },
  }] });
  const first: any = Array.isArray(res) ? res[0] : res;
  const hash = first?.transaction?.hash ?? first?.transaction_outcome?.id ?? first?.transactionHash;
  if (!hash) throw new Error("Wallet did not return a transaction result. Check your wallet before retrying.");
  const out = await provider.txStatus(hash, accountId);
  const status: any = out?.status;
  if (status && typeof status === "object" && "Failure" in status) throw new Error(failureMessage(status.Failure));
  if (!status || typeof status !== "object" || !("SuccessValue" in status)) {
    throw new Error(`Transaction ${hash} has not reached a confirmed final result. Check your wallet before retrying.`);
  }
  return { transactionHash: hash };
}

function failureMessage(failure: any): string {
  const f = failure?.FunctionCallError?.ExecutionError ?? failure;
  if (typeof f === "string") return f;
  return (f?.SmartContractExecutionError as string)
    ?? f?.HostError
    ?? f?.MethodNotFound
    ?? JSON.stringify(f);
}

/** NEAR whole-token amount → yocto string. */
export const nearToYocto = (n: string | number) =>
  utils.format.parseNearAmount(String(n))!;

/** Parse user-entered NEAR without rounding; rejects more than 24 decimals. */
export function parseNearAmount(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{0,24})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * BigInt(YOCTO_PER_NEAR) + BigInt((fraction + "0".repeat(24)).slice(0, 24));
}

/** Whole tokens purchasable with 1 NEAR at the given yocto/token price. */
export const tokensPerNear = (priceYocto: string) =>
  (BigInt(YOCTO_PER_NEAR) / BigInt(priceYocto)).toString();
