/**
 * A coin's mind: Proof-of-Thought records (verifiable in the browser),
 * the canon its holders adopted, and the "teach it" conviction market.
 */
import { useCallback, useEffect, useState } from "react";
import { sendFunctionCall } from "./lib/near";
import { PIT_BRAIN_URL, PREVIEW } from "./config";
import { ago, CoinRef, tokens, viewOf, YOCTO, parseTokens } from "./chain";
import { ConnectWalletButton } from "./ui";
import { friendly } from "./Trade";
import { checkThoughtResponse, SAMPLE_PROOF, SAMPLE_RESPONSE, sha256Hex, verifyThoughtSignature } from "./lib/thought-proof";
import archivedPitResponse from "./evidence/485018fc36787623138d2eb61f84b9a04430a0128848cce0171618518b342d86.json?raw";

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

const short = (s: string, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

const SAMPLE_THOUGHTS: Thought[] = [
  { ...SAMPLE_PROOF, id: 0, chat_id: "sample", attestation_hash: null, canon_hash: "f".repeat(64), tier: "Juvenile", recorded_ms: Date.now() - 600_000 },
];
const SAMPLE_CANON: Memory[] = [{ id: 0, text: "Always thank the holders who fed you first.", author: "early.testnet", created_ms: Date.now() - 4 * 86_400_000, backed: "0", adopted_ms: Date.now() - 86_400_000 }];
const SAMPLE_PENDING: MemoryView[] = [
  { memory: { id: 1, text: "You are allergic to rugs.", author: "fren.testnet", created_ms: Date.now() - 86_400_000, backed: (4_000_000n * 10n ** 18n).toString(), adopted_ms: null }, conviction: "62", threshold: "100" },
  { memory: { id: 2, text: "Your favorite food is staking rewards, served warm.", author: "chef.testnet", created_ms: Date.now() - 3_600_000, backed: (900_000n * 10n ** 18n).toString(), adopted_ms: null }, conviction: "12", threshold: "100" },
];

function useMind(contract: string) {
  const [thoughts, setThoughts] = useState<Thought[]>(PREVIEW ? SAMPLE_THOUGHTS : []);
  const [thoughtStatus, setThoughtStatus] = useState<"loading" | "ready" | "unavailable">(PREVIEW ? "ready" : "loading");
  const [canon, setCanon] = useState<[Memory[], string]>(PREVIEW ? [SAMPLE_CANON, "f".repeat(64)] : [[], ""]);
  const [pending, setPending] = useState<MemoryView[]>(PREVIEW ? SAMPLE_PENDING : []);
  const refresh = useCallback(async () => {
    if (PREVIEW) return;
    const [t, c, p] = await Promise.all([
      viewOf<Thought[]>(contract, "get_thoughts", {}).catch(() => null),
      viewOf<[Memory[], string]>(contract, "get_canon").catch(() => [[], ""] as [Memory[], string]),
      viewOf<MemoryView[]>(contract, "get_memories", { from_index: 0, limit: 20, pending_only: true }).catch(() => []),
    ]);
    if (t !== null) setThoughts(t);
    setThoughtStatus(t === null ? "unavailable" : "ready");
    setCanon(c);
    setPending(p);
  }, [contract]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);
  return { thoughts, thoughtStatus, canon, pending, refresh };
}

export function MindSection({ coin, accountId }: { coin: CoinRef; accountId: string | null }) {
  const [tab, setTab] = useState<"thoughts" | "canon" | "teach">("thoughts");
  const mind = useMind(coin.contract);
  return (
    <section className="section" id="mind" tabIndex={-1} aria-labelledby="mind-h">
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
        {tab === "thoughts" && <>
          {mind.thoughtStatus === "loading" && <p className="mind-empty" role="status">Reading thoughts from NEAR…</p>}
          {mind.thoughtStatus === "unavailable" && <div className="panel-body">
            <p role="status">{mind.thoughts.length ? "Showing the last available thought records." : "The thought records could not be loaded."}</p>
            <button className="btn dark" type="button" onClick={() => void mind.refresh()}>Retry</button>
          </div>}
          {mind.thoughtStatus === "ready" && mind.thoughts.length === 0 && <div className="panel-body">
            <p>No thoughts recorded for {coin.name} yet.</p>
          </div>}
          {!PREVIEW && mind.thoughtStatus !== "loading" && mind.thoughts.length === 0 && (
            <details className="sample-proof">
              <summary>Try Proof of Thought with a sample</summary>
              <Thoughts thoughts={SAMPLE_THOUGHTS} sample />
            </details>
          )}
          {mind.thoughts.length > 0 && <Thoughts thoughts={mind.thoughts} sample={PREVIEW} />}
        </>}
        {tab === "canon" && <Canon canon={mind.canon} />}
        {tab === "teach" && <Teach coin={coin} accountId={accountId} pending={mind.pending} onDone={mind.refresh} />}
      </div>
    </section>
  );
}

// ————— thoughts —————

function Thoughts({ thoughts, sample }: { thoughts: Thought[]; sample: boolean }) {
  return (
    <ul className="thoughts">
      {thoughts.map((t) => <ThoughtRow key={t.id} t={t} sample={sample} />)}
    </ul>
  );
}

type Check = { label: string; ok: boolean | null; note?: string };

/** NEAR AI's public attestation API (CORS-open, no key needed). */
const NEAR_AI_BASE = (import.meta.env.VITE_NEAR_AI_BASE as string) || "https://cloud-api.near.ai/v1";
const ARCHIVED_PIT_RESPONSE_HASH = "485018fc36787623138d2eb61f84b9a04430a0128848cce0171618518b342d86";

/**
 * Does NEAR AI's own attestation report bind this signing key? Gateway
 * signatures use the gateway TEE's key; provider_tee signatures use the
 * model TEE's key. Either must also be the start of the quote's report_data,
 * which is what ties the key to the Intel TDX quote.
 */
function keyInReport(report: any, t: Thought): boolean {
  const k = t.signing_address.toLowerCase();
  const bound = (a: any) => {
    if (!a || String(a.signing_address ?? "").toLowerCase().replace(/^0x/, "") !== k) return false;
    const quote = String(a.intel_quote ?? "").toLowerCase().replace(/^0x/, "");
    // TDX quote v4, TEE type 0x81. REPORTDATA occupies bytes 568–631.
    const reportData = /^0400[0-9a-f]{4}81000000[0-9a-f]{1248,}$/.test(quote) && quote.length % 2 === 0
      ? quote.slice(1136, 1264)
      : String(a.report_data ?? "").toLowerCase().replace(/^0x/, "");
    return /^[0-9a-f]{128}$/.test(reportData) && reportData.startsWith(k);
  };
  if (t.signature_kind === "gateway") return bound(report?.gateway_attestation);
  return Array.isArray(report?.model_attestations) && report.model_attestations.some(bound);
}

/**
 * Re-check a thought in the browser. The contract only proves *some* key signed
 * the hashes; whether that key lives in NEAR AI's TEE is checked here against
 * NEAR AI directly, never against our servers.
 */
async function verifyThought(t: Thought, sample: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const sigOk = await verifyThoughtSignature(t);
  checks.push({ label: `Ed25519 signature (${t.signature_kind}) is valid`, ok: sigOk, note: `key ${short(t.signing_address)}` });
  if (sample) {
    const { hashMatches, textMatches } = checkThoughtResponse(t, new TextEncoder().encode(SAMPLE_RESPONSE));
    checks.push({ label: "Sample response matches the signed hash", ok: hashMatches });
    checks.push({ label: "Sample response contains the displayed text", ok: textMatches });
    checks.push({ label: "Test signing key", ok: null, note: "Sample data only. On-chain recording and NEAR AI attestation apply to live thoughts." });
    return checks;
  }
  checks.push({ label: "The contract checked the same signature on-chain", ok: true });

  // The key must belong to NEAR AI's TEE: ask NEAR AI, not the brain.
  try {
    const res = await fetch(`${NEAR_AI_BASE}/attestation/report?model=${encodeURIComponent(t.model)}&signing_algo=ed25519`, { signal: AbortSignal.timeout(7000) });
    const report = res.ok ? await res.json() : null;
    const ok = report ? keyInReport(report, t) : false;
    checks.push(ok
      ? { label: "NEAR AI's current report lists this key", ok: true, note: "fetched from NEAR AI; hardware quote and certificate are not verified here" }
      : { label: "Key is not in NEAR AI's current attestation", ok: null, note: report ? "TEE keys rotate; older thoughts may predate the current key — see the archived report below" : `NEAR AI returned ${res.status}` });
  } catch {
    checks.push({ label: "NEAR AI's live attestation", ok: null, note: "couldn't reach NEAR AI from this browser" });
  }

  try {
    const archived = t.response_hash === ARCHIVED_PIT_RESPONSE_HASH;
    let bytes: Uint8Array;
    if (archived) {
      bytes = new TextEncoder().encode(archivedPitResponse);
    } else {
      if (!PIT_BRAIN_URL) throw new Error("Brain service unavailable");
      const response = await fetch(`${PIT_BRAIN_URL}/api/blob/${t.response_hash}`, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error("Response unavailable");
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const { hashMatches, textMatches } = checkThoughtResponse(t, bytes);
    checks.push({ label: "Raw model response re-hashes to the signed hash", ok: hashMatches, note: archived ? "archived testnet response" : undefined });
    checks.push({ label: "The signed response contains the displayed text", ok: textMatches });
  } catch {
    checks.push({ label: "Raw model response re-hashes to the signed hash", ok: null, note: "response bytes unavailable" });
  }
  if (t.attestation_hash && PIT_BRAIN_URL) {
    try {
      const response = await fetch(`${PIT_BRAIN_URL}/api/blob/${t.attestation_hash}`, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error("Report unavailable");
      const rep = new Uint8Array(await response.arrayBuffer());
      let ok = sha256Hex(rep) === t.attestation_hash;
      try {
        ok = ok && keyInReport(JSON.parse(new TextDecoder().decode(rep)), t);
      } catch {
        ok = false;
      }
      checks.push({ label: "Archived report matches its recorded hash and names the key", ok: ok ? null : false, note: "served by the brain; report authenticity and hardware quote are not verified" });
    } catch {
      checks.push({ label: "TEE attestation names this signing key", ok: null, note: "report not cached by the brain any more" });
    }
  } else if (t.attestation_hash) {
    checks.push({ label: "Archived attestation report", ok: null, note: "brain service not configured" });
  } else {
    checks.push({ label: "TEE attestation cited", ok: null, note: "none for this thought" });
  }
  return checks;
}

function ThoughtRow({ t, sample }: { t: Thought; sample: boolean }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setChecks(await verifyThought(t, sample));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="thought">
      <p className="thought-text">“{t.text}”</p>
      <div className="thought-meta">
        <span className="badge open">{sample ? "Sample · test key" : "✓ signed · on-chain"}</span>
        {!sample && <span>Thought #{t.id}</span>}
        <span>{t.model}</span>
        <span>{t.tier} brain</span>
        <span>{ago(t.recorded_ms)} ago</span>
        <button className="linkish" onClick={run} disabled={busy}>{busy ? "Checking…" : "Verify it yourself"}</button>
      </div>
      {checks && (
        <ul className="checks" aria-live="polite">
          {checks.map((c, i) => (
            <li key={i} className={c.ok === true ? "ok" : c.ok === false ? "bad" : "na"}>
              <span aria-hidden>{c.ok === true ? "✓" : c.ok === false ? "✗" : "–"}</span> {c.label}{c.note && <small> · {c.note}</small>}
            </li>
          ))}
          {!sample && <li className="na"><small>Canon seen: {short(t.canon_hash, 8)} · chat {t.chat_id}</small></li>}
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
          ? PREVIEW ? <p className="muted">Teaching requires a live market and a connected wallet.</p> : <ConnectWalletButton label="Connect wallet to teach" />
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
