import { defineConfig } from "vite";
import { createRheaProxy } from "./server/rhea-proxy.mjs";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Wallet-selector ships raw ESM; keep it out of the pre-bundler or React
// context errors appear. `events` is a Node builtin wallet-selector imports as
// a named CJS export — alias it to our browser EventEmitter shim.
export default defineConfig({
  plugins: [react(), { name: "rhea-proxy", configureServer(server) { const handle = createRheaProxy(); server.middlewares.use((req, res, next) => { handle(req, res).then(done => { if (!done) next(); }).catch(next); }); } }],
  resolve: {
    alias: {
      events: path.resolve(__dirname, "src/lib/events-polyfill.ts"),
    },
  },
  build: {
    // near-api-js v1 has circular requires (common-index ↔ providers ↔ account)
    // that only work in Node's exact require order. Keep that order in prod.
    commonjsOptions: { strictRequires: true },
  },
  optimizeDeps: {
    esbuildOptions: { define: { global: "globalThis" } },
  },
});
