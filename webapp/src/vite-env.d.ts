/// <reference types="vite/client" />

/** Build-time configuration (see .env.local.example). */
interface ImportMetaEnv {
  readonly VITE_NEAR_NETWORK?: "testnet" | "mainnet";
  readonly VITE_NEAR_RPC?: string;
  readonly VITE_NEAR_AI_BASE?: string;
  readonly VITE_PIT_FACTORY?: string;
  readonly VITE_PIT_CONTRACT?: string;
  readonly VITE_PIT_BRAIN_URL?: string;
  readonly VITE_PIT_GATE_URL?: string;
  readonly VITE_WALLET_CONTRACT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
