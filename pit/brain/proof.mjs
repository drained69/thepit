/**
 * Proof of Thought: verifiable inference on NEAR AI Cloud.
 *
 * Per docs.near.ai/cloud/verification: the signature covers
 *   gateway:      "<sha256(request body)>:<sha256(response body)>"
 *   provider_tee: "<model>:<sha256(request body)>:<sha256(response body)>"
 * over the exact HTTP body bytes, signed with an Ed25519 key whose public key
 * appears in the TEE attestation report (fetched *before* the completion).
 * The coin contract re-verifies the signature on-chain in `record_thought`.
 */
import crypto from "node:crypto";

export const sha256hex = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function ed25519Verify(text, signatureHex, publicKeyHex) {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]);
    const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signatureHex.replace(/^0x/, ""), "hex"));
  } catch {
    return false;
  }
}

// ————— raw bodies, served by hash so anyone can re-check a thought —————

const BLOB_MAX = 600;
const BLOB_MAX_BYTES = 32 * 1024 * 1024;
const SINGLE_BLOB_MAX_BYTES = 2 * 1024 * 1024;
let blobBytes = 0;
const blobs = new Map(); // sha256 hex → Buffer
export function keepBlob(buf) {
  if (buf.length > SINGLE_BLOB_MAX_BYTES) throw new Error("Proof evidence exceeds size limit");
  const h = sha256hex(buf);
  if (!blobs.has(h)) { blobs.set(h, buf); blobBytes += buf.length; }
  while (blobs.size > BLOB_MAX || blobBytes > BLOB_MAX_BYTES) {
    const oldest = blobs.keys().next().value;
    blobBytes -= blobs.get(oldest).length;
    blobs.delete(oldest);
  }
  return h;
}
export const getBlob = (hash) => blobs.get(hash);

// ————— attestation (cached per model, refreshed hourly) —————

const ATTESTATION_TTL_MS = 60 * 60 * 1000;
const attestations = new Map(); // "<base>|<model>" → { hash, at }

/**
 * True when the report binds `key`: gateway signatures → the gateway TEE's key,
 * provider_tee → a model TEE's key, and the key must lead the quote's report_data.
 * Same rule the web app applies to NEAR AI's live report.
 */
export function keyInReport(bytes, kind, key) {
  let r;
  try {
    r = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  const bound = (a) => !!a && String(a.signing_address ?? "").toLowerCase().replace(/^0x/, "") === key
    && String(a.report_data ?? "").toLowerCase().startsWith(key);
  return kind === "gateway" ? bound(r?.gateway_attestation) : Array.isArray(r?.model_attestations) && r.model_attestations.some(bound);
}

async function attestationHash(cfg, model, log) {
  const cacheKey = `${cfg.aiBase}|${model}`;
  const cached = attestations.get(cacheKey);
  if (cached && Date.now() - cached.at < ATTESTATION_TTL_MS) return cached.hash;
  try {
    const url = new URL(`${cfg.aiBase}/attestation/report`);
    url.searchParams.set("model", model);
    url.searchParams.set("signing_algo", "ed25519");
    url.searchParams.set("nonce", crypto.randomBytes(32).toString("hex"));
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json", authorization: `Bearer ${cfg.aiKey}`, "x-no-aliasing": "true", "accept-encoding": "identity" },
    });
    if (!res.ok) throw new Error(`attestation ${res.status}`);
    const hash = keepBlob(Buffer.from(await res.arrayBuffer()));
    attestations.set(cacheKey, { hash, at: Date.now() });
    return hash;
  } catch (e) {
    log(`attestation for ${model} unavailable: ${e.message}`);
    return null;
  }
}

async function fetchSignature(cfg, chatId) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${cfg.aiBase}/signature/${encodeURIComponent(chatId)}?signing_algo=ed25519`, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json", authorization: `Bearer ${cfg.aiKey}` },
    });
    if (res.status === 404) {
      await new Promise((r) => setTimeout(r, 1000)); // signatures can lag the completion briefly
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error_code) return null;
    return body;
  }
  return null;
}

/**
 * One chat completion with everything needed to prove it later.
 * Returns { content, usage, proof | null } where proof matches the contract's ThoughtInput.
 */
export async function provenCompletion(cfg, payload, log) {
  const attestation_hash = await attestationHash(cfg, payload.model, log);
  const requestBytes = Buffer.from(JSON.stringify(payload));
  const res = await fetch(`${cfg.aiBase}/chat/completions`, {
    signal: AbortSignal.timeout(120000),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.aiKey}`,
      "x-no-aliasing": "true",
      "accept-encoding": "identity",
    },
    body: requestBytes,
  });
  const responseBytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`inference ${res.status}: ${responseBytes.toString().slice(0, 200)}`);
  const body = JSON.parse(responseBytes.toString("utf8"));
  const content = body.choices?.[0]?.message?.content?.trim() ?? "";
  const request_hash = sha256hex(requestBytes);
  const response_hash = keepBlob(responseBytes);
  keepBlob(requestBytes);

  let sig = null;
  try { sig = body.id ? await fetchSignature(cfg, body.id) : null; }
  catch (e) { log(`signature lookup failed: ${e?.message ?? e}; thought stays unverified`); }
  if (!sig?.signature || !sig?.signing_address || (sig.signing_algo && sig.signing_algo !== "ed25519")) {
    log(`no ed25519 signature for ${body.id ?? "?"}: thought stays unverified`);
    return { content, usage: body.usage ?? {}, proof: null };
  }
  // Exact documented shapes; use the server's signature_kind when given.
  const shapes = {
    gateway: `${request_hash}:${response_hash}`,
    provider_tee: `${payload.model}:${request_hash}:${response_hash}`,
  };
  const kind = sig.signature_kind ?? Object.keys(shapes).find((k) => shapes[k] === sig.text);
  const signature_hex = String(sig.signature).replace(/^0x/, "").toLowerCase();
  const signing_address = String(sig.signing_address).replace(/^0x/, "").toLowerCase();
  if (!kind || sig.text !== shapes[kind] || !ed25519Verify(shapes[kind], signature_hex, signing_address)) {
    log(`signature for ${body.id} doesn't verify locally: not recording`);
    return { content, usage: body.usage ?? {}, proof: null };
  }
  // Only cite the attestation if it actually names this signing key; if the
  // key rotated, drop the cache so the next thought attests fresh (before it).
  let attested = attestation_hash;
  if (attested && !keyInReport(getBlob(attested), kind, signing_address)) {
    attestations.delete(`${cfg.aiBase}|${payload.model}`);
    log(`signing key ${signing_address.slice(0, 12)}… not in cached attestation: recording without it`);
    attested = null;
  }
  return {
    content,
    usage: body.usage ?? {},
    proof: {
      text: content,
      model: payload.model,
      chat_id: String(body.id),
      signature_kind: kind,
      request_hash,
      response_hash,
      signature_hex,
      signing_address,
      attestation_hash: attested,
    },
  };
}
