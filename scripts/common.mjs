/**
 * tee-gate helpers shared by node scripts: env, RPC, error extraction.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname ?? ".", "..");

export function loadEnv(file = path.join(REPO, "scripts", ".env")) {
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /([\w-]+)=(.*)/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

export const REPO_ROOT = REPO;
export const WASM_PATH = path.join(REPO, "contracts", "human-sale", "target", "near", "human_sale.wasm");
export const SIM_ROOT_PUB = path.join(REPO, "res", "sim-root.pub");

export const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
export const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.pages.dev";
export const OWNER_ID = process.env.OWNER_ID ?? "";
export const GATE_URL = process.env.GATE_URL ?? "http://localhost:8788";
/** Sale is 300M tokens (30%); total 1B × 1e24 atoms. String keeps BigInt JSON-safe. */
export const TOKEN_TOTAL_SUPPLY_ATOMS = "1000000000000000000000000000000000";

/** Epoch schedule (demo): 3 × 5 min human epochs, then 5 min open phase.
 *  near-sdk 5.x JSON schema: u128 contract fields arrive as JSON NUMBERS. */
export function demoEpochs(nowMs = Date.now()) {
  const starts_at_ms = nowMs + 120_000; // 2 min to deposit funds / register verifier
  const w = 300_000; // 5 min each (24h in production)
  const y = BigInt(10) ** 24n;
  const price = (tokensPerNear) => Number(y / BigInt(tokensPerNear));
  const e = (i, tokensPerNear, cap, perBuyer) => ({
    starts_at_ms: starts_at_ms + i * w,
    ends_at_ms: starts_at_ms + (i + 1) * w,
    price_yocto_per_token: price(tokensPerNear),
    per_buyer_max_tokens: perBuyer,
    epoch_cap_tokens: cap,
  });
  return {
    epochs: [
      e(0, 50_000_000, 30_000_000, 2_000_000), // Genesis: 50M t/N, 2M/buyer
      e(1, 30_000_000, 80_000_000, 10_000_000), // Epoch 2: 30M t/N
      e(2, 16_666_666, 140_000_000, 30_000_000), // Epoch 3: ~16.67M t/N
    ],
    open_cfg: {
      // Public phase: strictly worse price than every priority epoch.
      ends_at_ms: starts_at_ms + 3 * w + 300_000,
      price_yocto_per_token: price(6_666_666), // ≈ 3× worse than epoch 3
      per_buyer_max_tokens: 10_000_000,
      open_cap_tokens: 50_000_000,
    },
  };
}

/** Pull the contract panic string out of a thrown near-api-js error. */
export function panicText(err) {
  const depth = (o) => {
    if (o == null || typeof o !== "object") return [];
    const out = [];
    for (const [k, v] of Object.entries(o)) {
      if (/SmartContractExecutionError|HostError|functionCallError/i.test(k)) out.push(typeof v === "string" ? v : JSON.stringify(v));
      if (typeof v === "string" && v.length < 400) out.push(v);
      out.push(...depth(v));
    }
    return out;
  };
  const all = [String(err?.message ?? err), JSON.stringify(err?.jsonError ?? ""), ...depth(err?.jsonError ?? err)];
  const hit = all.find((s) => s.includes("Panicked:")) ?? all.find((s) => /[A-Z][A-Za-z]{6,}/.test(s) && s.length < 300);
  return (hit ?? "").replace(/^[\s\S]*?Panicked: */, "Panicked: ").slice(0, 300) || "unknown-failure";
}
