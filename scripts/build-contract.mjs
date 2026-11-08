#!/usr/bin/env node
/** Build the NEAR contract WASM with the toolchain required by near-sdk 5.30. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = path.join(repo, "contracts", "human-sale");
const toolchain = "1.97.1";

const rustc = spawnSync("rustup", ["which", "rustc", "--toolchain", toolchain], { encoding: "utf8" });
if (rustc.status !== 0) {
  throw new Error(`Rust ${toolchain} is required. Install it with: rustup toolchain install ${toolchain} --target wasm32-unknown-unknown`);
}

const installedTargets = spawnSync("rustup", ["target", "list", "--installed", "--toolchain", toolchain], { encoding: "utf8" });
if (installedTargets.status !== 0 || !installedTargets.stdout.split(/\r?\n/).includes("wasm32-unknown-unknown")) {
  throw new Error(`Install the WASM target with: rustup target add wasm32-unknown-unknown --toolchain ${toolchain}`);
}

const build = spawnSync("rustup", ["run", toolchain, "cargo", "build", "--manifest-path", path.join(contractDir, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"], {
  cwd: repo,
  env: { ...process.env, RUSTC: rustc.stdout.trim() },
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const wasmSource = path.join(contractDir, "target", "wasm32-unknown-unknown", "release", "human_sale.wasm");
const wasmDest = path.join(contractDir, "target", "near", "human_sale.wasm");
fs.mkdirSync(path.dirname(wasmDest), { recursive: true });
fs.copyFileSync(wasmSource, wasmDest);
console.log(`Built deployable WASM: ${wasmDest}`);
