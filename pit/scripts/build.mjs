#!/usr/bin/env node
/**
 * Build the The Pit and mock-pool WASMs with cargo-near (sets `cfg(near)` so
 * near-sdk uses real host functions). Output: contracts/<name>/target/near/.
 * Extra args are passed through, e.g. `--locked`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crates = [
  ["pit", "pit.wasm"],
  ["mock-pool", "mock_pool.wasm"],
  ["mock-agent-registry", "mock_agent_registry.wasm"],
  ["factory", "pit_factory.wasm"],
];

for (const [dir, wasm] of crates) {
  const crate = path.join(root, "contracts", dir);
  const build = spawnSync("cargo", ["near", "build", "non-reproducible-wasm", "--no-abi", ...process.argv.slice(2)], {
    cwd: crate,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const dest = path.join(crate, "target", "near", wasm);
  if (!fs.existsSync(dest)) throw new Error(`expected ${dest}`);
  console.log(`Built ${path.relative(root, dest)} (${fs.statSync(dest).size} bytes)`);
}
