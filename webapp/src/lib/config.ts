/** Runtime config — override with VITE_* env vars (.env.local). */
export const SALE_CONTRACT =
  (import.meta.env.VITE_SALE_CONTRACT as string) || "human-sale.testnet";
export const GATE_URL =
  (import.meta.env.VITE_GATE_URL as string) || "http://localhost:8788";
/** hex ed25519 sim-root public key — copied from repo res/sim-root.pub. */
export const SIM_ROOT_PUBKEY_HEX =
  (import.meta.env.VITE_SIM_ROOT_PUBKEY as string) || "829f7a1c072d4491c72be6a3b812413c48ee049009bdbbbd60594e8ec9c7ca99";

/** 1e24 — yocto-scale decimals of $HUMAN atoms per whole token. */
export const ATOMS_PER_TOKEN = BigInt("1000000000000000000000000");
/** yocto per 1 NEAR. */
export const YOCTO_PER_NEAR = "1000000000000000000000000";
export const T_GAS = 1_000_000_000_000n;
