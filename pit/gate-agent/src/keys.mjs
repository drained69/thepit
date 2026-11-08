/** Ed25519 helpers for NEAR keys, using only node:crypto. */
import crypto from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  const hex = n.toString(16);
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), n === 0n ? Buffer.alloc(0) : body]);
}

export function base58Encode(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** From a NEAR "ed25519:<base58>" secret (64-byte secret‖public, or 32-byte seed). */
export function signerFromNearSecret(secret) {
  const raw = base58Decode(secret.replace(/^ed25519:/, ""));
  const seed = raw.subarray(0, 32);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicRaw = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    accountId: publicRaw.toString("hex"), // implicit account id
    publicKey: `ed25519:${base58Encode(publicRaw)}`,
    nearSecret: `ed25519:${base58Encode(Buffer.concat([seed, publicRaw]))}`,
    sign: (bytes) => crypto.sign(null, bytes, privateKey).toString("base64"),
  };
}

export function randomNearSecret() {
  const seed = crypto.randomBytes(32);
  return signerFromNearSecret(`ed25519:${base58Encode(seed)}`).nearSecret;
}
