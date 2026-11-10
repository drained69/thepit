/**
 * A coin's mind: Proof-of-Thought records (verifiable in the browser),
 * the canon its holders adopted, and the "teach it" conviction market.
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { useEffect, useState } from "react";
import { connect, sendFunctionCall } from "./lib/near";
import { PIT_BRAIN_URL, PREVIEW } from "./config";
import { ago, CoinRef, tokens, viewOf, YOCTO, parseTokens } from "./chain";
import { friendly } from "./Trade";

export interface Thought {
  id: number; text: string; model: string; chat_id: string; signature_kind: string;
  request_hash: string; response_hash: string; signature_hex: string; signing_address: string;
  attestation_hash: string | null; canon_hash: string; tier: string; recorded_ms: number;
}
interface Memory { id: number; text: string; author: string; created_ms: number; backed: string; adopted_ms: number | null }
interface MemoryView { memory: Memory; conviction: string; threshold: string }
interface Backing { amount: string; since_ms: number; deposit: string }

/** Storage deposits; the contract keeps only what the record uses and refunds the rest. */
const PROPOSE_DEPOSIT = (YOCTO / 50n).toString();
const BACK_DEPOSIT = (YOCTO / 100n).toString();

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const short = (s: string, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

const SAMPLE_THOUGHTS: Thought[] = [
  { id: 2, text: "Ate 0.2 NEAR of fees today. I can now count to four. Holders, I'm proud of us.", model: "openai/gpt-oss-120b", chat_id: "chatcmpl-sample", signature_kind: "gateway", request_hash: "a".repeat(64), response_hash: "b".repeat(64), signature_hex: "c".repeat(128), signing_address: "d".repeat(64), attestation_hash: "e".repeat(64), canon_hash: "f".repeat(64), tier: "Juvenile", recorded_ms: Date.now() - 600_000 },
  { id: 1, text: "Somebody threw 20 NEAR in me. I felt that. Brain wrinkle unlocked.", model: "openai/gpt-oss-20b", chat_id: "chatcmpl-sample-0", signature_kind: "gateway", request_hash: "a".repeat(64), response_hash: "b".repeat(64), signature_hex: "c".repeat(128), signing_address: "d".repeat(64), attestation_hash: null, canon_hash: "0".repeat(64), tier: "Larva", recorded_ms: Date.now() - 7_200_000 },
];
const SAMPLE_CANON: Memory[] = [{ id: 0, text: "Always thank the holders who fed you first.", author: "early.testnet", created_ms: Date.now() - 4 * 86_400_000, backed: "0", adopted_ms: Date.now() - 86_400_000 }];
const SAMPLE_PENDING: MemoryView[] = [
  { memory: { id: 1, text: "You are allergic to rugs.", author: "fren.testnet", created_ms: Date.now() - 86_400_000, backed: (4_000_000n * 10n ** 18n).toString(), adopted_ms: null }, conviction: "62", threshold: "100" },
  { memory: { id: 2, text: "Your favorite food is staking rewards, served warm.", author: "chef.testnet", created_ms: Date.now() - 3_600_000, backed: (900_000n * 10n ** 18n).toString(), adopted_ms: null }, conviction: "12", threshold: "100" },
];

function useMind(contract: string) {
  const [thoughts, setThoughts] = useState<Thought[]>(PREVIEW ? SAMPLE_THOUGHTS : []);
  const [canon, setCanon] = useState<[Memory[], string]>(PREVIEW ? [SAMPLE_CANON, "f".repeat(64)] : [[], ""]);
  const [pending, setPending] = useState<MemoryView[]>(PREVIEW ? SAMPLE_PENDING : []);
  const refresh = async () => {
    if (PREVIEW) return;
    const [t, c, p] = await Promise.all([
      viewOf<Thought[]>(contract, "get_thoughts", {}).catch(() => []),
      viewOf<[Memory[], string]>(contract, "get_canon").catch(() => [[], ""] as [Memory[], string]),
      viewOf<MemoryView[]>(contract, "get_memories", { from_index: 0, limit: 20, pending_only: true }).catch(() => []),
    ]);
    setThoughts(t);
    setCanon(c);
    setPending(p);
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [contract]);
  return { thoughts, canon, pending, refresh };
}

export function MindSection({ coin, accountId }: { coin: CoinRef; accountId: string | null }) {
  const [tab, setTab] = useState<"thoughts" | "canon" | "teach">("thoughts");
  const mind = useMind(coin.contract);
  return (
    <section className="section" id="mind" aria-labelledby="mind-h">
      <div className="centered">
        <p className="eyebrow">Proof of Thought · holder-owned memory</p>
        <h2 id="mind-h">Its <span className="hl">mind</span>, on-chain</h2>
        <p className="lede">The coin contract checks each recorded thought's signature. Use “Verify it yourself” to check the signing key against NEAR AI's attestation. Holders decide what joins its canon.</p>
      </div>
      <div className="terminal mind">
        <div className="seg wide mind-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "thoughts"} onClick={() => setTab("thoughts")}>Thoughts · {mind.thoughts.length}</button>
          <button role="tab" aria-selected={tab === "canon"} onClick={() => setTab("canon")}>Canon · {mind.canon[0].length}</button>
          <button role="tab" aria-selected={tab === "teach"} onClick={() => setTab("teach")}>Teach it</button>
        </div>
        {tab === "thoughts" && <Thoughts coin={coin} thoughts={mind.thoughts} />}
        {tab === "canon" && <Canon canon={mind.canon} />}
        {tab === "teach" && <Teach coin={coin} accountId={accountId} pending={mind.pending} onDone={mind.refresh} />}
      </div>
    </section>
  );
}

// ————— thoughts —————

function Thoughts({ coin, thoughts }: { coin: CoinRef; thoughts: Thought[] }) {
  if (thoughts.length === 0) return <p className="mind-empty">No recorded thoughts yet. {coin.name} thinks once its brain has eaten.</p>;
  return (
    <ul className="thoughts">
      {thoughts.map((t) => <ThoughtRow key={t.id} t={t} />)}
    </ul>
  );
}

type Check = { label: string; ok: boolean | null; note?: string };

/** NEAR AI's public attestation API (CORS-open, no key needed). */
const NEAR_AI_BASE = (import.meta.env.VITE_NEAR_AI_BASE as string) || "https://cloud-api.near.ai/v1";

/**
 * Does NEAR AI's own attestation report bind this signing key? Gateway
 * signatures use the gateway TEE's key; provider_tee signatures use the
 * model TEE's key. Either must also be the start of the quote's report_data,
 * which is what ties the key to the Intel TDX quote.
 */
function keyInReport(report: any, t: Thought): boolean {
  const k = t.signing_address.toLowerCase();
  const bound = (a: any) => !!a && String(a.signing_address ?? "").toLowerCase().replace(/^0x/, "") === k
    && String(a.report_data ?? "").toLowerCase().startsWith(k);
  if (t.signature_kind === "gateway") return bound(report?.gateway_attestation);
  return Array.isArray(report?.model_attestations) && report.model_attestations.some(bound);
}

/**
 * Re-check a thought in the browser. The contract only proves *some* key signed
 * the hashes; whether that key lives in NEAR AI's TEE is checked here against
 * NEAR AI directly, never against our servers.
 */
async function verifyThought(t: Thought): Promise<Check[]> {
  const checks: Check[] = [];
  const signed = t.signature_kind === "provider_tee" ? `${t.model}:${t.request_hash}:${t.response_hash}` : `${t.request_hash}:${t.response_hash}`;
  let sigOk = false;
  try {
    sigOk = await ed.verifyAsync(hex(t.signature_hex), new TextEncoder().encode(signed), hex(t.signing_address));
  } catch { /* malformed → false */ }
  checks.push({ label: `Ed25519 signature (${t.signature_kind}) is valid`, ok: sigOk, note: `key ${short(t.signing_address)}` });
  checks.push(PREVIEW
    ? { label: "Sample thought", ok: null, note: "not recorded on-chain" }
    : { label: "The contract checked the same signature on-chain", ok: true, note: "the contract does not establish the signing key's owner" });

  // The key must belong to NEAR AI's TEE: ask NEAR AI, not the brain.
  try {
    const res = await fetch(`${NEAR_AI_BASE}/attestation/report?model=${encodeURIComponent(t.model)}&signing_algo=ed25519`);
    const report = res.ok ? await res.json() : null;
    const ok = report ? keyInReport(report, t) : false;
    checks.push(ok
      ? { label: "NEAR AI's current report lists this key", ok: true, note: "fetched from NEAR AI; hardware quote and certificate are not verified here" }
      : { label: "Key is not in NEAR AI's current attestation", ok: null, note: report ? "TEE keys rotate; older thoughts may predate the current key — see the archived report below" : `NEAR AI returned ${res.status}` });
  } catch {
    checks.push({ label: "NEAR AI's live attestation", ok: null, note: "couldn't reach NEAR AI from this browser" });
  }

  if (!PIT_BRAIN_URL) {
    checks.push({ label: "Raw response re-hashes and contains the text", ok: null, note: "brain service not configured" });
    return checks;
  }
  try {
    const body = new Uint8Array(await (await fetch(`${PIT_BRAIN_URL}/api/blob/${t.response_hash}`)).arrayBuffer());
    const hashOk = toHex(sha256(body)) === t.response_hash;
    const content = JSON.parse(new TextDecoder().decode(body))?.choices?.[0]?.message?.content?.trim();
    checks.push({ label: "Raw model response re-hashes to the signed hash", ok: hashOk });
    checks.push({ label: "…and the posted text is exactly what the model said", ok: hashOk && content === t.text });
  } catch {
    checks.push({ label: "Raw model response re-hashes to the signed hash", ok: null, note: "body not cached by the brain any more" });
  }
  if (t.attestation_hash) {
    try {
      const rep = new Uint8Array(await (await fetch(`${PIT_BRAIN_URL}/api/blob/${t.attestation_hash}`)).arrayBuffer());
      let ok = toHex(sha256(rep)) === t.attestation_hash;
      try {
        ok = ok && keyInReport(JSON.parse(new TextDecoder().decode(rep)), t);
      } catch {
        ok = false;
      }
      checks.push({ label: "Archived report matches its recorded hash and names the key", ok: ok ? null : false, note: "served by the brain; report authenticity and hardware quote are not verified" });
    } catch {
      checks.push({ label: "TEE attestation names this signing key", ok: null, note: "report not cached by the brain any more" });
    }
  } else {
    checks.push({ label: "TEE attestation cited", ok: null, note: "none for this thought" });
  }
  return checks;
}

function ThoughtRow({ t }: { t: Thought }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setChecks(await verifyThought(t));
    setBusy(false);
  };
  return (
    <li className="thought">
      <p className="thought-text">“{t.text}”</p>
      <div className="thought-meta">
        <span className="badge open" title={PREVIEW ? "Sample data" : "The contract checked the signature; hardware attestation requires independent verification"}>{PREVIEW ? "sample" : "✓ signed · on-chain"}</span>
        <span>{t.model}</span>
        <span>{t.tier} brain</span>
        <span>{ago(t.recorded_ms)} ago</span>
        <button className="linkish" onClick={run} disabled={busy}>{busy ? "Checking…" : "Verify it yourself"}</button>
      </div>
      {checks && (
        <ul className="checks">
          {checks.map((c, i) => (
            <li key={i} className={c.ok === true ? "ok" : c.ok === false ? "bad" : "na"}>
              <span aria-hidden>{c.ok === true ? "✓" : c.ok === false ? "✗" : "–"}</span> {c.label}{c.note && <small> · {c.note}</small>}
            </li>
          ))}
          <li className="na"><small>Canon seen: {short(t.canon_hash, 8)} · chat {t.chat_id}</small></li>
        </ul>
      )}
    </li>
  );
}

// ————— canon —————

function Canon({ canon }: { canon: [Memory[], string] }) {
  const [list, hash] = canon;
  return (
    <div className="canon">
      {list.length === 0
        ? <p className="mind-empty">No beliefs adopted yet. Its holders haven't taught it anything — go to “Teach it”.</p>
        : <ol>{list.map((m) => <li key={m.id}>“{m.text}” <small>— proposed by {m.author}</small></li>)}</ol>}
      <p className="muted small">Canon hash <code>{short(hash || "0".repeat(64), 12)}</code> · every recorded thought shows which canon it saw.</p>
    </div>
  );
}

// ————— teach it —————

function Teach({ coin, accountId, pending, onDone }: { coin: CoinRef; accountId: string | null; pending: MemoryView[]; onDone: () => void }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const bytes = new TextEncoder().encode(text.trim()).length;

  const propose = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await sendFunctionCall(coin.contract, "propose_memory", { text: text.trim() }, 30, PROPOSE_DEPOSIT);
      setText("");
      setMsg({ cls: "ok", text: "Proposed. Back it with your tokens to build conviction." });
      onDone();
    } catch (e: any) {
      setMsg({ cls: "err", text: friendly(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="teach">
      <div className="teach-form">
        <p className="muted">Write something {coin.name} should believe. Holders lock {coin.ticker} behind it; conviction grows with every hour they hold. At 1% of supply held for 3 days (or 2% for 1.5 days…) it joins the canon forever.</p>
        <div className="field">
          <label htmlFor="mem"><span>New memory</span><span className={bytes > 280 ? "bad" : ""}>{bytes}/280</span></label>
          <div className="row"><textarea id="mem" rows={2} value={text} maxLength={400} placeholder="You are allergic to rugs." onChange={(e) => setText(e.target.value)} /></div>
        </div>
        {!accountId
          ? <button className="btn launch" disabled={PREVIEW} onClick={() => connect().catch(console.error)}>Connect wallet to teach</button>
          : <button className="btn light" disabled={busy || bytes === 0 || bytes > 280 || PREVIEW} onClick={propose}>{busy ? "Proposing…" : "Propose memory"}</button>}
        {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
      </div>
      <ul className="memories">
        {pending.length === 0 ? <li className="mind-empty">No memories waiting. Propose the first one.</li> : pending.map((v) => (
          <MemoryRow key={v.memory.id} coin={coin} v={v} accountId={accountId} onDone={onDone} />
        ))}
      </ul>
    </div>
  );
}

function MemoryRow({ coin, v, accountId, onDone }: { coin: CoinRef; v: MemoryView; accountId: string | null; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [mine, setMine] = useState<Backing | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const conv = BigInt(v.conviction), thr = BigInt(v.threshold) || 1n;
  const pct = Number((conv * 1000n) / thr) / 10;

  useEffect(() => {
    if (PREVIEW || !accountId) return;
    viewOf<Backing | null>(coin.contract, "get_backing", { id: v.memory.id, account_id: accountId }).then(setMine).catch(() => {});
  }, [accountId, v.memory.backed]);

  const act = async (method: string, args: object, deposit = "0") => {
    setBusy(true);
    setMsg(null);
    try {
      await sendFunctionCall(coin.contract, method, args, 50, deposit);
      setAmount("");
      onDone();
    } catch (e: any) {
      setMsg(friendly(e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };
  const amt = parseTokens(amount);

  return (
    <li className="memory">
      <p>“{v.memory.text}”</p>
      <div className="meter" aria-label="conviction"><div style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <div className="memory-meta">
        <small>{pct >= 100 ? "Ready to adopt" : `${pct.toFixed(1)}% conviction`} · {tokens(v.memory.backed)} {coin.ticker} backing · by {v.memory.author}</small>
        {accountId && !PREVIEW && (
          <span className="memory-actions">
            {pct >= 100 && <button className="btn go" disabled={busy} onClick={() => act("adopt_memory", { id: v.memory.id })}>Adopt</button>}
            {mine && <button className="btn dark" disabled={busy} onClick={() => act("unback_memory", { id: v.memory.id })}>Withdraw {tokens(mine.amount)}</button>}
            <span className="row mini"><input inputMode="decimal" placeholder={coin.ticker} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${coin.ticker} to back with`} /></span>
            <button className="btn light" disabled={busy || !amt} onClick={() => act("back_memory", { id: v.memory.id, amount: amt!.toString() }, BACK_DEPOSIT)}>Back</button>
          </span>
        )}
      </div>
      {msg && <div className="notice err">{msg}</div>}
    </li>
  );
}
