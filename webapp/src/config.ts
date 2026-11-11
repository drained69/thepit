/** The Pit runtime config — set VITE_PIT_* at build time (.env.local or Railway variables). */
export const TESTNET_DEPLOYMENT = {
  factory: "pit.pitdeployer.testnet",
  coin: "pit.pit.pitdeployer.testnet",
  gatedCoin: "demo.pit.pitdeployer.testnet",
  pool: "pool.pitdeployer.testnet",
  registry: "registry.pitdeployer.testnet",
  brain: "brain.pitdeployer.testnet",
  keeper: "keeper.pitdeployer.testnet",
  publishBurn: "32.17",
} as const;

export const NETWORK = import.meta.env.VITE_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
/** A single coin, for deployments without the launchpad. */
export const PIT_CONTRACT = import.meta.env.VITE_PIT_CONTRACT || "";
/** An explicit empty factory value keeps preview mode available. */
export const PIT_FACTORY = import.meta.env.VITE_PIT_FACTORY
  ?? (NETWORK === "testnet" && !PIT_CONTRACT ? TESTNET_DEPLOYMENT.factory : "");
export const SHOW_TESTNET_DEPLOYMENT = NETWORK === "testnet" && PIT_FACTORY === TESTNET_DEPLOYMENT.factory;
/** The launch gate that issues early-access passes (pit/gate-agent; local default port 3140). */
export const PIT_GATE_URL = (import.meta.env.VITE_PIT_GATE_URL as string) || "http://localhost:3140";
/** The brain service's base URL; its /api/feed powers "recent activity". */
export const PIT_BRAIN_URL = (import.meta.env.VITE_PIT_BRAIN_URL as string) || "";
/** Neither configured → preview mode with sample data and a clear banner. */
export const PREVIEW = !PIT_FACTORY && !PIT_CONTRACT;
