import { useEffect, useState } from "react";
import { SALE_CONTRACT, getAccount, signOut, viewMethod, connect, sendFunctionCall, selector, parseNearAmount, type SaleOverview, type BuyerState } from "./lib/near";
import { GATE_URL } from "./lib/config";

const TABS = ["trade", "connect", "attestation", "gate", "buy", "snipers"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>("trade");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [overview, setOverview] = useState<SaleOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: { unsubscribe: () => void } | undefined;
    selector().then((s) => {
      if (cancelled) return;
      setAccountId(s.store.getState().accounts[0]?.accountId ?? null);
      unsubscribe = s.store.observable.subscribe((state) => {
        setAccountId(state.accounts[0]?.accountId ?? null);
      });
    }).catch((e) => setErr(String(e)));
    const loadOverview = () => viewMethod<SaleOverview>(SALE_CONTRACT, "sale_overview")
      .then((state) => { if (!cancelled) { setOverview(state); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    loadOverview();
    const poll = window.setInterval(loadOverview, 12_000);
    return () => { cancelled = true; window.clearInterval(poll); unsubscribe?.unsubscribe(); };
  }, []);

  useEffect(() => {
    const goToTab = (event: Event) => setTab((event as CustomEvent<Tab>).detail);
    window.addEventListener("human-tab", goToTab);
    return () => window.removeEventListener("human-tab", goToTab);
  }, []);

  const refresh = async () => {
    setOverview(await viewMethod<SaleOverview>(SALE_CONTRACT, "sale_overview"));
    setAccountId((await getAccount())?.accountId ?? null);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">H</div><span>human<span className="brand-dot">.</span></span><span className="brand-divider"/><span className="product-label">LAUNCH TERMINAL</span></div>
        <nav className="topnav">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
            {tabLabel(t)}
          </button>
        ))}
        </nav>
        <div className="top-actions"><span className="network-pill"><i/> NEAR TESTNET</span>{accountId ? <button className="wallet-button" onClick={() => { signOut().then(refresh).catch(setErr); }}>{accountId.slice(0, 7)}…{accountId.slice(-5)} <span>⌄</span></button> : <button className="wallet-button primary" onClick={() => connect().catch(setErr)}>Connect wallet ↗</button>}</div>
      </header>

      <div className="ticker"><span className="live-dot"/> DEMO ENVIRONMENT <span className="ticker-sep">/</span> SIMULATED ATTESTATION <span className="ticker-spacer"/> SALE <b>{overview?.sale_id ?? "HUMAN-001"}</b><span className={`phase phase-${overview?.phase ?? "pre"}`}>{overview?.phase ?? "loading"}</span><span className="ticker-spacer"/> CONTRACT <code>{SALE_CONTRACT}</code></div>

      {err && <div className="banner error">{err}</div>}

      <main>
        {tab === "trade" && <TradeView accountId={accountId} overview={overview} onDone={refresh} />}
        {tab === "connect" && <Connect accountId={accountId} overview={overview} onDone={refresh} />}
        {tab === "attestation" && <AttInspector overview={overview} />}
        {tab === "gate" && <Gate accountId={accountId} overview={overview} onDone={refresh} />}
        {tab === "buy" && <Buy accountId={accountId} overview={overview} onDone={refresh} />}
        {tab === "snipers" && <Snipers accountId={accountId} overview={overview} />}
      </main>

      <footer>
        <span><i className="live-dot"/> NEAR TESTNET <span className="ticker-sep">·</span> Simulated attestation <span className="ticker-sep">·</span> Challenge is not proof of unique personhood</span>
        <span>Passes bind wallet · purchases settle on-chain</span>
      </footer>
    </div>
  );
}

const tabLabel = (t: Tab) =>
  ({ trade: "Trade", connect: "Overview", attestation: "Trust", gate: "Get pass", buy: "Buy", snipers: "Bot defense" } as const)[t];

function TradeView({ accountId, overview, onDone }: { accountId: string | null; overview: SaleOverview | null; onDone: () => void }) {
  const points = [22, 25, 23, 28, 26, 31, 27, 35, 32, 38, 34, 40, 37, 43, 39, 48, 44, 51, 47, 55, 52, 61, 57, 66, 62, 71, 68, 77, 72, 82, 79, 91];
  const chart = points.map((p, i) => `${(i / (points.length - 1)) * 1000},${180 - p * 1.65}`).join(" ");
  const sold = overview ? fmtTokens(overview.sold_atoms) : "—";
  const left = overview ? fmtTokens(overview.unminted_sale_atoms) : "—";
  return <>
    <div className="market-heading"><div className="token-avatar">H</div><div><div className="eyebrow">FAIR LAUNCH · NEAR</div><h1>$HUMAN <span className="market-pair">HUMAN / NEAR</span></h1><p>Pass-gated early allocation. Verifiable rules, transparent settlement.</p></div><div className="market-heading-actions"><span className={`phase phase-${overview?.phase ?? "pre"}`}>{overview?.phase ?? "loading"} phase</span><button className="subtle-button" onClick={onDone}>↻ Refresh</button></div></div>
    <div className="market-stats">
      <div className="primary-stat"><small>INDICATIVE PRICE</small><strong>{overview?.phase === "human" && overview.current_epoch != null ? `${(1_000_000_000_000_000_000_000_000n / BigInt(overview.epochs[overview.current_epoch].price_yocto_per_token)).toLocaleString()} <i>HUMAN / NEAR</i>` : overview?.phase === "open" && overview.open ? `${(1_000_000_000_000_000_000_000_000n / BigInt(overview.open.price_yocto_per_token)).toLocaleString()} <i>HUMAN / NEAR</i>` : "—"}</strong><em>Contract price · not a market quote</em></div>
      <div><small>SALE PHASE</small><strong>{overview?.phase ?? "Loading"}</strong><em>{overview?.current_epoch != null ? `Allocation epoch ${overview.current_epoch + 1}` : "On-chain state"}</em></div>
      <div><small>EARLY ALLOCATION SOLD</small><strong>{sold} <i>HUMAN</i></strong><em>of sale allocation</em></div>
      <div><small>REMAINING ALLOCATION</small><strong>{left} <i>HUMAN</i></strong><em>{overview?.verifier_count ?? 0} verifier key(s) registered</em></div>
    </div>
    <div className="trading-layout">
      <div className="market-column">
        <section className="panel chart-panel"><div className="panel-head"><div><div className="eyebrow">PRICE OVERVIEW</div><h2>Launch curve</h2></div><div className="chart-controls"><span className="selected">ALL</span><span>1D</span><span>1W</span><span>1M</span></div></div>
          <div className="chart-price"><strong>{overview?.phase === "human" && overview.current_epoch != null ? (1_000_000_000_000_000_000_000_000n / BigInt(overview.epochs[overview.current_epoch].price_yocto_per_token)).toLocaleString() : overview?.phase === "open" && overview.open ? (1_000_000_000_000_000_000_000_000n / BigInt(overview.open.price_yocto_per_token)).toLocaleString() : "—"}</strong><span>HUMAN / NEAR</span><span className="demo-chart-label">ILLUSTRATIVE DEMO</span></div>
          <div className="chart-wrap"><svg viewBox="0 0 1000 190" preserveAspectRatio="none" role="img" aria-label="Illustrative launch curve, not live market data"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#b4ff58" stopOpacity=".24"/><stop offset="100%" stopColor="#b4ff58" stopOpacity="0"/></linearGradient></defs><path d={`M ${chart} L 1000,190 L 0,190 Z`} fill="url(#area)"/><polyline points={chart} fill="none" stroke="#b4ff58" strokeWidth="3" vectorEffect="non-scaling-stroke"/><line x1="0" y1="125" x2="1000" y2="125" stroke="#2a303a" strokeDasharray="5 7"/></svg><div className="chart-axis"><span>Launch</span><span>Epoch 1</span><span>Epoch 2</span><span>Now</span></div></div>
          <div className="chart-legend"><span><i className="legend-line"/> Contract launch price</span><span>Illustrative only · No secondary market data</span></div>
        </section>
        <section className="panel allocation-panel"><div className="panel-head"><div><div className="eyebrow">TOKEN DISTRIBUTION</div><h2>Launch allocation</h2></div><span className="muted">Sale progress</span></div><div className="progress-track"><div style={{width: `${overview && BigInt(overview.sale_supply_atoms) ? Math.min(100, Number(BigInt(overview.sold_atoms) * 100n / BigInt(overview.sale_supply_atoms))) : 0}%`}}/></div><div className="allocation-numbers"><div><small>Purchased</small><b>{sold} <i>HUMAN</i></b></div><div><small>Available</small><b>{left} <i>HUMAN</i></b></div><div><small>Verifier keys</small><b>{overview?.verifier_count ?? 0}</b></div></div></section>
        <section className="panel explanation-panel"><div className="eyebrow">HOW THE FAIR LAUNCH WORKS</div><div className="steps"><div><span>01</span><b>Connect</b><small>Link a NEAR wallet</small></div><div><span>02</span><b>Get a pass</b><small>Complete the allocation check</small></div><div><span>03</span><b>Settle on-chain</b><small>Contract validates and mints</small></div></div><p>Passes are short-lived, wallet-bound, capped and one-use. CAPTCHA and proof-of-work add friction; they do not prove unique personhood.</p></section>
      </div>
      <aside className="trade-column"><Buy accountId={accountId} overview={overview} onDone={onDone}/><section className="panel wallet-summary"><div className="panel-head"><div><div className="eyebrow">YOUR ACCOUNT</div><h2>Wallet overview</h2></div></div>{accountId ? <><div className="wallet-address">◉ <b>{accountId}</b></div><p>Connect state is active. Your pass is stored in this browser and bound to this account.</p></> : <><p>Connect a wallet to request an allocation pass and participate in the sale.</p><button className="wallet-button primary" onClick={() => connect().catch(console.error)}>Connect NEAR wallet</button></>}</section><section className="security-note"><span>✳</span><div><b>Trust, with clear limits</b><p>This build uses simulated attestation from a normal process. It does not claim hardware TEE verification.</p><button className="text-button" onClick={() => window.dispatchEvent(new CustomEvent("human-tab", {detail:"attestation"}))}>Review verifier details ↗</button></div></section></aside>
    </div>
  </>;
}

const Connect = ({ accountId, overview, onDone }: { accountId: string | null; overview: SaleOverview | null; onDone: () => void }) => (
  <section>
    <h2>Connect a testnet wallet</h2>
    {accountId ? (
      <div className="card">
        <p>wallet: <b>{accountId}</b></p>
        <p className="dim">sale in <b>{overview?.phase}</b> · verifier keys pinned on-chain: {overview?.verifier_count ?? 0}</p>
        <button onClick={onDone}>refresh</button>
      </div>
    ) : (
      <div className="card">
        <p>No wallet connected. Early allocation requires a short-lived, account-bound pass.</p>
        <button onClick={() => connect().catch(console.error)}>Open wallet selector</button>
      </div>
    )}
  </section>
);

const AttInspector = ({ overview }: { overview: SaleOverview | null }) => {
  const [verifiers, setVerifiers] = useState<{ name: string; pubkey_hex: string; evidence_hash_hex: string; approved: boolean }[]>([]);
  useEffect(() => {
    if (!overview) return;
    viewMethod<typeof verifiers>(SALE_CONTRACT, "verifiers_list").then(setVerifiers).catch(() => setVerifiers([]));
  }, [overview?.verifier_count]);
  return (
  <section>
    <h2>Verifier evidence</h2>
    <p className="dim">
      The contract accepts passes signed by an Ed25519 key added by the sale owner
      with <code>register_verifier</code>. This demo uses a simulated quote and a
      normal server process. The contract does not validate TEE evidence, and this
      challenge does not establish unique personhood.
    </p>
    <div className="grid2">
      <div className="card">
        <h3>Pinned verifier keys</h3>
        {verifiers.length ? verifiers.map((v, i) => (
          <div key={i} className="kv">
            <b>{v.name}</b>
            <code>{v.pubkey_hex.slice(0, 20)}…{v.pubkey_hex.slice(-8)}</code>
            <span className={`badge ${v.approved ? "ok" : "bad"}`}>{v.approved ? "approved" : "revoked"}</span>
            <small className="dim">evidence hash: {v.evidence_hash_hex}</small>
          </div>
        )) : <p className="dim">none registered yet — run <code>scripts/register-verifier.mjs</code></p>}
      </div>
      <div className="card">
        <h3>How the chain of trust works</h3>
        <ol>
          <li>The demo gate creates a simulated report; no hardware quote is produced.</li>
          <li>The report contains a demo signing key and nonce, but does not prove what code runs.</li>
          <li>The browser checks the simulated report signature and payload structure.</li>
          <li>The contract verifies the pass signature against the <b>owner-registered</b> key. Registration is the trust decision.</li>
        </ol>
        <p className="dim">Full flow: <code>docs/04-architecture.md</code></p>
      </div>
    </div>
  </section>
  );
};

const fmtTokens = (atoms: string) => {
  const n = BigInt(atoms) / 1_000_000_000_000_000_000_000_000n;
  return n.toLocaleString("en-US");
};

const Gate = ({ accountId, overview, onDone }: { accountId: string | null; overview: SaleOverview | null; onDone: () => void }) => {
  const [challenge, setChallenge] = useState<any>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [powState, setPowState] = useState<string>("");
  const [result, setVerification] = useState<any>(null);
  const [att, setAtt] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const startGate = async () => {
    if (!overview || overview.phase !== "human" || overview.current_epoch == null || !accountId) return;
    setBusy(true);
    try {
      const url = new URL("/api/gate/challenge", GATE_URL);
      url.searchParams.set("buyer", accountId);
      url.searchParams.set("epoch", String(overview.current_epoch));
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error ?? `gate request failed (${response.status})`);
      setChallenge(data);
      setVerification(null);
      setAtt(null);
      setPicked(null);
    } catch (e: any) {
      setVerification({ error: e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };

  const pow = async () => {
    if (!challenge) return;
    setBusy(true);
    try {
      const { solvePow } = await import("./lib/pow");
      const target = BigInt(challenge.pow_target);
      const t0 = performance.now();
      const sol = solvePow(challenge.nonce, target, (at) => setPowState(`${(at / 1000).toFixed(0)}k hashes…`));
      const ms = performance.now() - t0;
      setPowState(`solved in ${(ms / 1000).toFixed(1)}s: "${sol}"`);

      const verify = await fetch(new URL("/api/gate/verify", GATE_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: challenge.session_id, pow_solution: sol, answer: String(picked) }),
      }).then((x) => x.json());

      if (verify.error) {
        setVerification({ error: verify.error });
      } else {
        const passData = JSON.parse(verify.pass);
        const { verifyEvidence, verifyPassSignature } = await import("./lib/simVerify");
        const evidenceCheck = await verifyEvidence(verify.evidence, {
          requestNonce: passData.nonce,
          signingAddress: verify.verifier.signing_address,
          policyHash: verify.policy_hash,
        });
        const passSignatureOk = await verifyPassSignature(verify.pass, verify.sig_b64, verify.verifier.signing_address);
        setAtt(evidenceCheck);
        if (!evidenceCheck.ok || !passSignatureOk) {
          setVerification({ error: "Pass or evidence verification failed. The pass was not saved." });
          return;
        }
        setVerification(verify);
        localStorage.setItem("human-pass", verify.pass);
        localStorage.setItem("human-sig", verify.sig_b64);
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  if (!accountId) return <section><h2>Human Gate</h2><p className="dim">connect a wallet first</p></section>;

  if (!challenge) return (
    <section>
      <h2>Human Gate</h2>
      <p className="dim">A challenge plus browser proof-of-work issues a wallet-bound pass during the live pass-gated epoch. This adds friction; it does not prove unique personhood.</p>
      {overview?.phase === "human"
        ? <p>Epoch {overview.current_epoch} is live. Your pass is bound to <b>{accountId}</b>.</p>
        : <p className="warn">The sale is currently <b>{overview?.phase ?? "loading"}</b>. Passes are issued only during a live allocation epoch.</p>}
      <button onClick={startGate} disabled={busy || overview?.phase !== "human"}>{busy ? "connecting…" : "Start allocation check"}</button>
      {result?.error && <div className="card error">{result.error}</div>}
    </section>
  );

  if (!result) return (
    <section>
      <h2>Human Gate</h2>
      <div className="card">
        <p><b>{challenge.challenge.prompt}</b></p>
        <p className="dim">{challenge.challenge.hint}</p>
        <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
          {challenge.challenge.options.map((o: string, i: number) => (
            <button key={i} className={picked === i ? "picked" : ""} style={{ fontSize: 34 }} onClick={() => setPicked(i)}>
              {o}
            </button>
          ))}
        </div>
        <p className="pow">{powState || `run browser pow with target ${challenge.pow_target}`}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={picked == null || busy} onClick={pow}>{busy ? "working…" : "Complete challenge"}</button>
          <button className="link" onClick={() => setChallenge(null)}>reset</button>
        </div>
      </div>
    </section>
  );

  if (result.error) return (
    <section>
      <h2>Human Gate</h2>
      <div className="card error">gate said: <code>{result.error}</code></div>
      <button onClick={startGate}>try again</button>
    </section>
  );

  return (
    <section>
      <h2>✅ Pass issued</h2>
      <pre className="pass">{result.pass}</pre>
      <p className="dim">sig_b64 <code>{result.sig_b64.slice(0, 40)}…</code> · verifier <b>{result.verifier.name}</b> ({result.verifier.mode}) · expiry <b>{new Date(JSON.parse(result.pass).expires_at_ms).toLocaleTimeString()}</b></p>
      {att && <div className={`card att ${att.ok ? "ok" : "bad"}`}>
        <b>{att.badge}</b>
        <ul>{att.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
      </div>}
      <p className="dim">This pass is one-shot on-chain (sha256 nullifier). Bring it to the Buy tab within {Math.max(0, Math.round((JSON.parse(result.pass).expires_at_ms - Date.now()) / 1000))}s.</p>
    </section>
  );
};

const Buy = ({ accountId, overview, onDone }: { accountId: string | null; overview: SaleOverview | null; onDone: () => void }) => {
  const [pass, setPass] = useState<string>(() => localStorage.getItem("human-pass") || "");
  const [sig, setSig] = useState<string>(() => localStorage.getItem("human-sig") || "");
  const [amount, setAmount] = useState("0.005");
  const [log, setLog] = useState<string>("");
  const [buyerState, setBuyerState] = useState<BuyerState | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [loadingBuyer, setLoadingBuyer] = useState(true);

  useEffect(() => {
    setPass(localStorage.getItem("human-pass") || "");
    setSig(localStorage.getItem("human-sig") || "");
  }, []);

  useEffect(() => {
    setStorageReady(false);
    setBuyerState(null);
    if (!accountId) { setLoadingBuyer(false); return; }
    setLoadingBuyer(true);
    viewMethod<BuyerState>(SALE_CONTRACT, "buyer_state", { account: accountId })
      .then((state) => setBuyerState(state))
      .catch(() => setBuyerState(null))
      .finally(() => setLoadingBuyer(false));
    viewMethod<{ total: string; available: string } | null>(SALE_CONTRACT, "storage_balance_of", { account_id: accountId })
      .then((balance) => setStorageReady(balance !== null))
      .catch(() => setStorageReady(false));
  }, [accountId, overview?.sold_atoms]);

  if (!accountId) return <section><h2>Buy</h2><p className="dim">connect a wallet first</p></section>;

  const humanMode = overview?.phase === "human";
  const openMode = overview?.phase === "open";
  const phaseOk = humanMode || openMode;
  const epoch = humanMode ? overview.current_epoch! : null;
  const activeEpoch = humanMode && epoch != null ? overview!.epochs[epoch] : null;
  const activeOpen = openMode ? overview?.open : null;
  const price = activeEpoch ? BigInt(activeEpoch.price_yocto_per_token) : activeOpen ? BigInt(activeOpen.price_yocto_per_token) : null;
  let buyerObj: any = null;
  try { buyerObj = pass ? JSON.parse(pass) : null; } catch { buyerObj = null; }
  const passValid = !!buyerObj && buyerObj.buyer === accountId && buyerObj.sale === overview?.sale_id &&
    buyerObj.epoch === epoch && buyerObj.expires_at_ms > Date.now() && /^\d+$/.test(buyerObj.max_amount ?? "") && !!sig;
  const spendYocto = parseNearAmount(amount);
  const exactSpend = !!price && spendYocto != null && spendYocto > 0n && spendYocto % price === 0n;
  const wholeTokens = exactSpend ? spendYocto! / price! : 0n;
  const atomsPerToken = 1_000_000_000_000_000_000_000_000n;
  const buyerPhaseAtoms = BigInt(buyerState?.per_phase.find((p) => p.phase === (humanMode ? "human" : "open") && p.epoch === epoch)?.bought ?? "0");
  const passLimit = BigInt(passValid ? buyerObj.max_amount : "0");
  const buyerCap = activeEpoch ? BigInt(activeEpoch.per_buyer_max_tokens) : activeOpen ? BigInt(activeOpen.per_buyer_max_tokens) : 0n;
  const epochCap = activeEpoch ? BigInt(activeEpoch.cap_tokens) : activeOpen ? BigInt(activeOpen.cap_tokens) : 0n;
  const soldTokens = activeEpoch ? BigInt(activeEpoch.sold_tokens) : activeOpen ? BigInt(activeOpen.sold_tokens) : 0n;
  const buyerLeft = buyerCap - buyerPhaseAtoms / atomsPerToken;
  const epochLeft = epochCap - soldTokens;
  const buyerLimit = buyerLeft > 0n ? buyerLeft : 0n;
  const epochLimit = epochLeft > 0n ? epochLeft : 0n;
  const allocationLimit = humanMode ? passLimit : buyerLimit;
  const orderLimit = allocationLimit < epochLimit ? allocationLimit : epochLimit;
  const orderValid = !loadingBuyer && buyerState !== null && (humanMode ? passValid : openMode) && exactSpend && wholeTokens > 0n && wholeTokens <= orderLimit && !overview?.paused && !overview?.finalized;

  const doStorageDeposit = async () => {
    try {
      setLog("sending storage_deposit…");
      const bounds = await viewMethod<{ min: string; max: string | null }>(SALE_CONTRACT, "storage_balance_bounds");
      await sendFunctionCall(SALE_CONTRACT, "storage_deposit", { account_id: accountId, registration_only: true }, "30", bounds.min);
      setLog("registered — you can buy now");
      setStorageReady(true);
      onDone();
    } catch (e: any) { setLog(String(e?.message ?? e)); }
  };

  const doPurchase = async () => {
    try {
      if (!orderValid || spendYocto == null) throw new Error("check the pass, sale phase, and order limit before buying");
      if (!storageReady) throw new Error("register this wallet for token storage first");
      const deposit = String(spendYocto);
      setLog(`purchase(): deposit ${amount} NEAR → ${wholeTokens.toLocaleString()} HUMAN…`);
      const res = humanMode
        ? await sendFunctionCall(SALE_CONTRACT, "purchase", { pass, sig_b64: sig }, "200", deposit)
        : await sendFunctionCall(SALE_CONTRACT, "purchase_open_phase", {}, "100", deposit);
      setLog(`minted ✅ tx ${res.transactionHash}`);
      localStorage.removeItem("human-pass"); // pass is one-shot
      localStorage.removeItem("human-sig");
      setPass("");
      setSig("");
      onDone();
    } catch (e: any) { setLog(`❌ ${e?.message ?? e}`); }
  };

  return (
    <section>
      <h2>Buy $HUMAN</h2>
      <div className="grid2">
        <div className="card">
          <h3>{humanMode ? "Allocation pass" : "Sale access"}</h3>
          {humanMode
            ? passValid ? <><pre className="pass">{pass}</pre><p className="dim">Pass limit: {passLimit.toLocaleString()} HUMAN · this epoch · {Math.max(0, Math.floor((buyerObj.expires_at_ms - Date.now()) / 1000))}s left</p></> : <p className="warn">No valid pass for this wallet and live epoch. Complete the allocation check first.</p>
            : openMode ? <p>Open phase is permissionless at the published higher price. No pass is required.</p> : <p className="dim">No purchase is available in this phase.</p>}
        </div>
        <div className="card">
          <h3>Order</h3>
          {phaseOk ? (
            <>
              <p>{humanMode ? <>epoch <b>{epoch}</b></> : <b>Open phase · public price</b>} · price <b>{price ? (1_000_000_000_000_000_000_000_000n / price).toLocaleString() : "?"} HUMAN / NEAR</b></p>
              <label>NEAR to spend: <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
              <p>Estimated allocation: <b>{wholeTokens.toLocaleString()}</b> HUMAN</p>
              {spendYocto == null && <p className="warn">Enter a positive NEAR amount with up to 24 decimal places.</p>}
              {spendYocto != null && spendYocto > 0n && !exactSpend && <p className="warn">Amount must be an exact multiple of this epoch’s price per token.</p>}
              {exactSpend && wholeTokens > orderLimit && <p className="warn">Order is above your remaining allocation or sale limit ({orderLimit.toLocaleString()} HUMAN).</p>}
              <p className="dim">{loadingBuyer ? "Loading wallet allocation…" : `Remaining available to this wallet: ${orderLimit.toLocaleString()} HUMAN`} · wallet storage: {storageReady ? "registered" : "needs registration"}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={doStorageDeposit} disabled={storageReady}>1) {storageReady ? "wallet registered" : "register wallet"}</button>
                <button onClick={doPurchase} disabled={!orderValid || !storageReady}>2) buy allocation</button>
              </div>
            </>
          ) : <p className="warn">sale phase is <b>{overview?.phase}</b> — pass-gated purchases need a live allocation epoch</p>}
          <pre className="log">{log}</pre>
        </div>
      </div>
    </section>
  );
};

const Snipers = ({ accountId, overview }: { accountId: string | null; overview: SaleOverview | null }) => {
  const [log, setLog] = useState<string>("");
  const [victimPass, setVictimPass] = useState<{ pass: string; sig_b64: string } | null>(null);
  const liveEpoch = overview?.phase === "human" ? overview.current_epoch : null;

  const rawAttack = async () => {
    try {
      setLog("sniping: raw purchase() with no pass…");
      await sendFunctionCall(SALE_CONTRACT, "purchase", { pass: "", sig_b64: "" }, "100", "300000000000000000000000");
      setLog("❌ unexpected: tx succeeded?!");
    } catch (e: any) {
      const exp = /UnknownVerifier|require\(\)|sig_b64|bad pass/.exec(e?.message ?? "");
      setLog(exp
        ? `🛑 rejected by contract as expected: ${e?.message ?? e}`
        : `⚠️ transaction failed for an unexpected reason: ${e?.message ?? e}`);
    }
  };

  const stealPass = async () => {
    try {
      setLog("attacking: grabbing a pass from a DIFFERENT buyer via the gate, then replaying from your wallet…");
      if (liveEpoch == null) throw new Error("pass-theft demo needs an active pass-gated epoch");
      const url = new URL("/api/gate/challenge", GATE_URL);
      url.searchParams.set("buyer", "sniper-victim.testnet");
      url.searchParams.set("epoch", String(liveEpoch));
      const r = await fetch(url).then((x) => x.json());
      const { solvePow } = await import("./lib/pow");
      const sol = solvePow(r.nonce, BigInt(r.pow_target));
      let solved: any = null;
      for (let i = 0; i < 3; i++) {
        const q = await fetch(`${GATE_URL}/api/gate/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: r.session_id, pow_solution: sol, answer: String(i) }),
        }).then((x) => x.json());
        if (q.pass) { solved = q; break; }
      }
      if (!solved) throw new Error("gate never accepted");
      setVictimPass({ pass: solved.pass, sig_b64: solved.sig_b64 });
      await sendFunctionCall(SALE_CONTRACT, "purchase", { pass: solved.pass, sig_b64: solved.sig_b64 }, "100", "300000000000000000000000");
      throw new Error("unexpected success: contract accepted a pass bound to another account");
    } catch (e: any) {
      const exp = /NotForYou/.exec(e?.message ?? "");
      setLog(exp
        ? `🛑 rejected by contract (buyer binding confirmed): ${e?.message ?? e}`
        : `⚠️ pass-theft result was not the expected buyer-binding rejection: ${e?.message ?? e}`);
    }
  };

  return (
    <section>
      <h2>Sniper Simulator</h2>
      <p className="dim">These demonstrations check two specific contract rules: missing verifier signature and buyer-bound passes. They do not prove every bot can be stopped.</p>
      <div className="card">
        <h3>1) Raw buy, no pass (expects <code>PassUnknownVerifier</code>)</h3>
        <button onClick={rawAttack} disabled={!accountId}>run attack</button>
        <h3>2) Stolen pass (expects <code>PassNotForYou</code>)</h3>
        <button onClick={stealPass} disabled={!accountId || liveEpoch == null}>run attack</button>
        {victimPass && <pre className="pass">{victimPass.pass}</pre>}
        <pre className="log">{log}</pre>
      </div>
    </section>
  );
};
