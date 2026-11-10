/**
 * Buyer-wallet eligibility, checked before a challenge is issued.
 *
 * The challenge alone can be solved by a script, and NEAR accounts are cheap,
 * so on its own it only adds friction. Requiring each buyer wallet to already
 * exist and hold a minimum NEAR balance puts a capital cost on every wallet a
 * bot farm runs in parallel. It does not prove a unique person.
 */

const YOCTO_PER_NEAR = 10n ** 24n;

/** "1.5" NEAR → yocto (BigInt). Empty / "0" disables the balance floor. */
export function parseNear(value) {
  const v = String(value ?? "").trim();
  if (!v) return 0n;
  if (!/^\d+(\.\d{1,24})?$/.test(v)) throw new Error(`invalid NEAR amount: ${v}`);
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

/**
 * @param {object} o
 * @param {(accountId: string) => Promise<{amount: string, locked?: string, storage_usage?: number} | null>} o.viewAccount
 *        null when the account doesn't exist
 * @param {bigint} o.minBalanceYocto  spendable NEAR the wallet must hold (0n = existence only)
 */
export function createEligibility({ viewAccount, minBalanceYocto, ttlMs = 60_000, now = Date.now, maxInFlight = 32 }) {
  const cache = new Map();
  let inFlight = 0;
  return async function eligible(buyer) {
    const hit = cache.get(buyer);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    // Uncached lookups hit the RPC: bound them so junk buyer names can't flood it.
    if (inFlight >= maxInFlight) return { ok: false, reason: "gate_busy", retry: true };
    inFlight++;
    let result;
    try {
      const account = await viewAccount(buyer);
      if (!account) result = { ok: false, reason: "buyer_account_not_found" };
      else if (BigInt(account.amount) < minBalanceYocto) result = { ok: false, reason: "buyer_balance_too_low", min_balance_yocto: minBalanceYocto.toString() };
      else result = { ok: true };
    } catch {
      // RPC trouble is not the buyer's fault, but don't cache it.
      return { ok: false, reason: "eligibility_unavailable", retry: true };
    } finally {
      inFlight--;
    }
    if (cache.size > 50_000) cache.clear();
    cache.set(buyer, { at: now(), result });
    return result;
  };
}

/** `viewAccount` over NEAR JSON-RPC. */
export function rpcViewAccount(rpcUrl, fetchImpl = fetch) {
  return async (accountId) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "gate", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.json();
    if (body.error) {
      const name = body.error?.cause?.name ?? "";
      if (name === "UNKNOWN_ACCOUNT") return null;
      throw new Error(name || "rpc_error");
    }
    return body.result;
  };
}
