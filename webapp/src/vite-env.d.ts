/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SALE_CONTRACT?: string;
  readonly VITE_GATE_URL?: string;
  readonly VITE_SIM_ROOT_PUBKEY?: string;
  readonly VITE_NEAR_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
