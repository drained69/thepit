/** The Pit — shared chain types, formatting, sample data and data hooks. */
import { useEffect, useState } from "react";
import { viewMethod } from "../lib/near";
import { PIT_BRAIN_URL, PIT_FACTORY, PREVIEW } from "./config";

export const YOCTO = 10n ** 24n;
export const TOKEN = 10n ** 18n;
/** Mirrors the revised coin: every sell funds a claim; gated buys fund pass records. */
export const TICKET_DEPOSIT = YOCTO / 250n;
export const PASS_STORAGE_FEE = YOCTO / 500n;

export type Phase = "not_started" | "gated" | "open";
export interface Tier { name: string; min_principal: string }
export interface Stats {
  principal: string; liquid: string; staked: string; unstaking: string; surplus: string;
  queue_owed: string; queue_len: number; total_harvested: string; total_fees: string;
  total_supply: string; spot_price: string; fee_bps: number; buffer_bps: number;
  tier_index: number; tier: Tier; next_tier: Tier | null; phase: Phase;
  creator?: { account_id: string; share_bps: number } | null; creator_earned?: string;
}
export interface Verifier { pubkey_hex: string; name: string; evidence_hash_hex: string }
export interface Launch {
  phase: Phase; epoch: number | null; now_ms: number;
  launch: null | { sale_id: string; starts_at_ms: number; gated_epochs: { ends_at_ms: number; per_buyer_max_tokens: string }[]; verifiers: Verifier[]; agent_registry: string | null };
}
/** `agentId` is set when a Shade Agent signed the pass (its account id is its key). */
export interface Pass { pass: string; sig_b64: string; verifier: string; agentId?: string }
export interface FeedItem {
  kind: string; text: string; at_ms: number; coin?: string;
  /** Present on thoughts: whether NEAR AI signed it and the contract recorded it. */
  proof?: { verified: boolean; onchain?: boolean; thought_id?: number | null; response_hash?: string; signing_address?: string; model?: string };
}
/** A coin in the factory registry. */
/** `icon` is an emoji; when `has_image`, the image lives in the coin's own `ft_metadata`. */
export interface CoinRecord { symbol: string; account_id: string; name: string; icon: string | null; has_image?: boolean; creator: string; creator_share_bps: number; created_ms: number }
export interface FactoryConfig { create_cost: string; coin_count: number; code_published: boolean; agent_registry: string | null; verifiers: Verifier[]; defaults: { fee_bps: number; buffer_bps: number } }
/** What a coin page needs to address one coin. */
export interface CoinRef { contract: string; symbol: string; ticker: string; name: string; icon: string | null; has_image?: boolean }

export const coinRef = (c: CoinRecord): CoinRef => ({ contract: c.account_id, symbol: c.symbol, ticker: c.symbol.toUpperCase(), name: c.name, icon: c.icon, has_image: c.has_image });

// ————— formatting —————

export const near = (y: string | bigint, d = 2) => {
  const s = 10n ** BigInt(d);
  const v = (BigInt(y) * s) / YOCTO;
  return `${(v / s).toLocaleString("en-US")}${d ? "." + (v % s).toString().padStart(d, "0") : ""}`;
};
export const tokens = (atoms: string | bigint) => {
  const n = Number(BigInt(atoms) / 10n ** 12n) / 1e6;
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(2);
};
export const parseTokens = (v: string): bigint | null => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{0,18})?$/.test(v.trim())) return null;
  const [w, f = ""] = v.trim().split(".");
  return BigInt(w) * TOKEN + BigInt((f + "0".repeat(18)).slice(0, 18));
};
export const ago = (ms: number) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
export const when = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const viewOf = <T,>(contract: string, m: string, a: object = {}) => viewMethod<T>(contract, m, a);
export const price = (s: Stats) => Number(BigInt(s.spot_price) / 10n ** 12n) / 1e12;

// ————— preview data (no factory configured) —————

export const SAMPLE_STATS: Stats = {
  principal: (2_876n * YOCTO).toString(), liquid: (575n * YOCTO).toString(), staked: (2_301n * YOCTO).toString(),
  unstaking: "0", surplus: (1_666n * YOCTO / 1000n).toString(), queue_owed: "0", queue_len: 0,
  total_harvested: (46n * YOCTO).toString(), total_fees: (29n * YOCTO).toString(),
  total_supply: (342_350_000n * TOKEN).toString(), spot_price: (2_800_000_000_000_000_000n).toString(), // ≈ launch price, 2.8e-6 NEAR
  fee_bps: 100, buffer_bps: 2000, tier_index: 1,
  tier: { name: "Juvenile", min_principal: (1_000n * YOCTO).toString() },
  next_tier: { name: "Adult", min_principal: (10_000n * YOCTO).toString() }, phase: "gated",
};
export const SAMPLE_LAUNCH: Launch = {
  phase: "gated", epoch: 0, now_ms: Date.now(),
  launch: {
    sale_id: "PIT-001", starts_at_ms: Date.now() - 600_000,
    gated_epochs: [
      { ends_at_ms: Date.now() + 3_000_000, per_buyer_max_tokens: "2000000" },
      { ends_at_ms: Date.now() + 6_600_000, per_buyer_max_tokens: "5000000" },
    ],
    verifiers: [], agent_registry: "pit-gate-agents.testnet",
  },
};
export const SAMPLE_FEED: FeedItem[] = [
  { kind: "thought", text: "Ate 0.02 NEAR of fees. Upgraded my vocabulary to three syllables.", at_ms: Date.now() - 120_000, proof: { verified: true, onchain: true } },
  { kind: "harvest", text: "Harvested 1.000 NEAR of staking rewards", at_ms: Date.now() - 900_000 },
  { kind: "buy", text: "A verified human bought 176.6k PIT", at_ms: Date.now() - 1_800_000 },
  { kind: "rebalance", text: "Staked 1.94 NEAR with the validator", at_ms: Date.now() - 3_600_000 },
];


const sample = (symbol: string, name: string, icon: string, principal: bigint, harvested: bigint, tier: string, phase: Phase): [CoinRecord, Stats] => [
  { symbol, account_id: `${symbol}.pit.testnet`, name, icon, creator: "someone.testnet", creator_share_bps: 2000, created_ms: Date.now() - 86_400_000 },
  { ...SAMPLE_STATS, principal: (principal * YOCTO).toString(), staked: ((principal * 4n) / 5n * YOCTO).toString(), liquid: (principal / 5n * YOCTO).toString(), total_harvested: (harvested * YOCTO / 100n).toString(), spot_price: ((3_000n + principal) * 10n ** 24n * TOKEN / (1_073_000_000n * TOKEN)).toString(), tier: { name: tier, min_principal: "0" }, phase },
];
export const SAMPLE_COINS: [CoinRecord, Stats][] = [
  sample("pit", "The Pit", "🕳️", 2_876n, 4_600n, "Juvenile", "gated"),
  sample("doge", "Doge Pit", "🐶", 12_400n, 21_000n, "Adult", "open"),
  sample("frog", "Frog Brain", "🐸", 640n, 310n, "Larva", "open"),
  sample("moon", "Moon Rock", "🌙", 0n, 0n, "Larva", "not_started"),
];

export const FEED_ICON: Record<string, string> = { thought: "🧠", harvest: "🍽️", buy: "🟢", sell: "🔴", rebalance: "⚖️", queue: "⏳", hungry: "😵", reply: "💬" };

// ————— data hooks —————

/** Live stats + launch schedule for one coin. */
export function useCoinChain(contract: string, fallback?: Stats) {
  const [stats, setStats] = useState<Stats | null>(PREVIEW ? fallback ?? SAMPLE_STATS : null);
  const [launch, setLaunch] = useState<Launch | null>(PREVIEW ? SAMPLE_LAUNCH : null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = async () => {
    if (PREVIEW) return;
    try {
      const [s, l] = await Promise.all([viewOf<Stats>(contract, "brain_stats"), viewOf<Launch>(contract, "launch_info")]);
      setStats(s);
      setLaunch(l);
      setErr(null);
    } catch (e: any) {
      setErr(`Can't reach ${contract} right now (${e?.message ?? e}). Retrying…`);
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [contract]);
  return { stats, launch, err, refresh };
}

/** The brain service's activity feed, for one coin or the whole launchpad. */
export function useFeed(symbol?: string) {
  const [feed, setFeed] = useState<FeedItem[]>(PREVIEW ? SAMPLE_FEED.map((f) => ({ ...f, coin: symbol ?? "pit" })) : []);
  useEffect(() => {
    if (PREVIEW || !PIT_BRAIN_URL) return;
    const load = () =>
      fetch(`${PIT_BRAIN_URL}/api/feed${symbol ? `?coin=${encodeURIComponent(symbol)}` : ""}`)
        .then((r) => r.json())
        .then((d) => Array.isArray(d.items) && setFeed(d.items.slice(0, 8)))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [symbol]);
  return feed;
}

/** Every coin on the launchpad with its live stats (newest first). */
export function useLaunchpad() {
  const [coins, setCoins] = useState<[CoinRecord, Stats | null][]>(PREVIEW ? SAMPLE_COINS : []);
  const [config, setConfig] = useState<FactoryConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(PREVIEW);
  const refresh = async () => {
    if (PREVIEW || !PIT_FACTORY) return;
    try {
      const [list, cfg] = await Promise.all([
        viewOf<CoinRecord[]>(PIT_FACTORY, "get_coins", { from_index: 0, limit: 100 }),
        viewOf<FactoryConfig>(PIT_FACTORY, "get_config"),
      ]);
      const stats = await Promise.all(list.map((c) => viewOf<Stats>(c.account_id, "brain_stats").catch(() => null)));
      setCoins(list.map((c, i) => [c, stats[i]]));
      setConfig(cfg);
      setErr(null);
    } catch (e: any) {
      setErr(`Can't reach the launchpad (${PIT_FACTORY}) right now (${e?.message ?? e}). Retrying…`);
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, []);
  return { coins, config, err, loaded, refresh };
}
