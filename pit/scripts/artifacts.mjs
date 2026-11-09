#!/usr/bin/env node
/**
 * Record the built contract artifacts (size + sha256) in
 * docs/deployment/artifacts.json. Run after `node pit/scripts/build.mjs`;
 * the mainnet deploy pins these hashes (MAINNET_*_CODE_SHA256).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ARTIFACTS = {
  coin: "pit/contracts/pit/target/near/pit.wasm",
  factory: "pit/contracts/factory/target/near/pit_factory.wasm",
};
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

const artifacts = {};
for (const [name, rel] of Object.entries(ARTIFACTS)) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`missing ${rel}: run node pit/scripts/build.mjs`);
  const bytes = fs.readFileSync(file);
  artifacts[name] = { path: rel, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
const burn = BigInt(artifacts.coin.bytes) * STORAGE_YOCTO_PER_BYTE * 10n;
const manifest = {
  generated_at_utc: new Date().toISOString(),
  features: "normal build; experimental rNEAR disabled",
  fresh_deployment_required: true,
  global_publish_burn_near: (Number(burn / 10n ** 20n) / 10_000).toFixed(4),
  artifacts,
};
fs.writeFileSync(path.join(ROOT, "docs/deployment/artifacts.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
