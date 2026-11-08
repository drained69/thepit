/** Order ticket for one coin: buy (with a human pass while gated), sell, gate flow. */
import { useEffect, useMemo, useState } from "react";
import { connect, NETWORK, parseNearAmount, sendFunctionCall, viewMethod } from "../lib/near";
import { PIT_GATE_URL, PREVIEW } from "./config";
import { PitLogo } from "./Logo";
import {
  CoinRef, Launch, near, parseTokens, Pass, PASS_STORAGE_FEE, SAMPLE_STATS, Stats, TICKET_DEPOSIT, TOKEN, tokens, viewOf, when,
} from "./chain";


export function ActionPanel({ coin, accountId, launch, stats, onDone }: { coin: CoinRef; accountId: string | null; launch: Launch | null; stats: Stats | null; onDone: () => void }) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  return (
    <div className="panel">
      <div className="tabs" role="tablist">
        <button role="tab" className="buy" aria-selected={tab === "buy"} onClick={() => setTab("buy")}>Buy</button>
        <button role="tab" className="sell" aria-selected={tab === "sell"} onClick={() => setTab("sell")}>Sell</button>
      </div>
      {tab === "buy" ? <BuyTab coin={coin} accountId={accountId} launch={launch} stats={stats} onDone={onDone} /> : <SellTab coin={coin} accountId={accountId} onDone={onDone} />}
      <div className="panel-foot">
        <a href="#docs">How does the pit work?</a>
      </div>
    </div>
  );
}

function ConnectPrompt({ text }: { text: string }) {
  return (
    <div className="panel-body">
      <div className="mascot"><PitLogo size={92} /></div>
      <h4>{text}</h4>
      <p>Connect a NEAR {NETWORK === "mainnet" ? "" : "testnet "}wallet to throw NEAR in the pit.</p>
      <button className="btn launch wide" disabled={PREVIEW} onClick={() => connect().catch(console.error)}>Connect wallet</button>
    </div>
  );
}

function BuyTab({ coin, accountId, launch, stats, onDone }: { coin: CoinRef; accountId: string | null; launch: Launch | null; stats: Stats | null; onDone: () => void }) {
  const view = <T,>(m: string, a: object = {}) => viewOf<T>(coin.contract, m, a);
  const PASS_KEY = `pit-pass:${coin.contract}`;
  const [amount, setAmount] = useState("1");
  const [quoted, setQuoted] = useState<{ key: string; value: bigint } | null>(null);
  const [registration, setRegistration] = useState<{ key: string; registered: boolean; cost: bigint } | null>(null);
  const [pass, setPass] = useState<Pass | null>(() => {
    try { return JSON.parse(localStorage.getItem(PASS_KEY) ?? "null"); } catch { return null; }
  });
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const phase = launch?.phase;
  const gated = phase === "gated";
  const registrationKey = `${coin.contract}:${accountId ?? ""}`;
  const currentRegistration = registration?.key === registrationKey ? registration : null;
  const registered = currentRegistration?.registered ?? false;
  const regCost = currentRegistration?.cost ?? 0n;

  useEffect(() => {
    if (PREVIEW || !accountId) return;
    let active = true;
    setRegistration(null);
    Promise.all([
      view<{ min: string } | null>("storage_balance_bounds"),
      view<object | null>("storage_balance_of", { account_id: accountId }),
    ]).then(([b, s]) => { if (!b) throw new Error("missing storage bounds"); if (active) setRegistration({ key: registrationKey, cost: BigInt(b.min), registered: !!s }); })
      .catch(() => { if (active) setMsg({ cls: "err", text: "Could not check token registration. Refresh the page to retry." }); });
    return () => { active = false; };
  }, [accountId, coin.contract]);

  // What actually reaches the curve: deposit − first-time registration − pass record fee.
  const effective = useMemo(() => {
    const y = parseNearAmount(amount);
    if (!y || (!PREVIEW && !currentRegistration)) return null;
    const v = y - (registered ? 0n : regCost) - (gated ? PASS_STORAGE_FEE : 0n);
    return v > 0n ? v : null;
  }, [amount, registered, regCost, gated, currentRegistration]);

  const quoteKey = `${coin.contract}:${accountId}:${effective}:${stats?.spot_price ?? ""}`;
  const quote = quoted?.key === quoteKey ? quoted.value : null;

  useEffect(() => {
    let active = true;
    setQuoted(null);
    if (!effective) return () => { active = false; };
    if (PREVIEW) setQuoted({ key: quoteKey, value: (effective * TOKEN * 99n) / 100n / BigInt(SAMPLE_STATS.spot_price) });
    else view<string>("quote_buy", { near_in: effective.toString() }).then((q) => { if (active) setQuoted({ key: quoteKey, value: BigInt(q) }); }).catch(() => { if (active) setQuoted(null); });
    return () => { active = false; };
  }, [quoteKey]);

  if (!accountId) return <ConnectPrompt text={gated ? "Humans first" : `Throw NEAR in ${coin.name}`} />;

  if (phase === "not_started" && launch?.launch) {
    return (
      <div className="panel-body">
        <div className="mascot"><PitLogo size={92} hungry /></div>
        <h4>{coin.name} opens soon</h4>
        <p>Launch starts {when(launch.launch.starts_at_ms)}. Nobody can buy before then — not even bots.</p>
      </div>
    );
  }

  let passData: any = null;
  try { passData = pass ? JSON.parse(pass.pass) : null; } catch { /* discard malformed local data */ }
  const passUsable = !!passData && passData.buyer === accountId && passData.epoch === launch?.epoch && passData.expires_at_ms > Date.now();

  if (gated && !passUsable) {
    return <HumanGate coin={coin} accountId={accountId} launch={launch!} onPass={(p) => { localStorage.setItem(PASS_KEY, JSON.stringify(p)); setPass(p); }} />;
  }

  const buy = async () => {
    const y = parseNearAmount(amount);
    if (!y || !quote) return;
    setBusy(true);
    setMsg(null);
    try {
      const minOut = ((quote * 97n) / 100n).toString(); // 3% slippage guard
      const before = BigInt(await view<string>("ft_balance_of", { account_id: accountId }));
      if (gated && pass?.agentId) {
        await sendFunctionCall(coin.contract, "buy_with_agent_pass", { pass: pass.pass, sig_b64: pass.sig_b64, agent_id: pass.agentId, min_tokens_out: minOut }, 120, y.toString());
      } else if (gated && pass) {
        await sendFunctionCall(coin.contract, "buy_with_pass", { pass: pass.pass, sig_b64: pass.sig_b64, min_tokens_out: minOut }, 60, y.toString());
      } else {
        await sendFunctionCall(coin.contract, "buy", { min_tokens_out: minOut }, 60, y.toString());
      }
      if (gated) { localStorage.removeItem(PASS_KEY); setPass(null); }
      const got = BigInt(await view<string>("ft_balance_of", { account_id: accountId })) - before;
      setMsg(got > 0n
        ? { cls: "ok", text: `You threw ${amount} NEAR in the pit and got ${tokens(got)} ${coin.ticker}. The brain twitches.` }
        : { cls: "warn", text: "Refunded: the gate wasn't valid when checked, or a cap was hit. Your NEAR came back." });
      onDone();
    } catch (e: any) {
      setMsg({ cls: "err", text: friendly(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body">
      {gated && passData && (
        <div className="notice ok">✓ Human pass ready · up to {Number(passData.max_amount).toLocaleString()} {coin.ticker} · {pass!.agentId ? "signed by a verified gate agent" : `signed by ${pass!.verifier}`} · expires {new Date(passData.expires_at_ms).toLocaleTimeString()}</div>
      )}
      <div className="field">
        <label htmlFor="buy-amt"><span>You throw in</span><span>{stats ? `1% fee feeds the brain` : ""}</span></label>
        <div className="row">
          <input id="buy-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="NEAR to spend" />
          <span className="unit">NEAR</span>
        </div>
      </div>
      <div className="quote"><span>You get ≈</span><b>{quote != null ? `${tokens(quote)} ${coin.ticker}` : "—"}</b></div>
      {!registered && <div className="quote"><span>One-time account setup</span><b>{near(regCost, 5)} NEAR</b></div>}
      {gated && <div className="quote"><span>Pass record fee</span><b>{near(PASS_STORAGE_FEE, 3)} NEAR</b></div>}
      <button className="btn go wide" disabled={busy || PREVIEW || !quote || (phase !== "gated" && phase !== "open")} onClick={buy}>{busy ? "Throwing…" : gated ? "Buy with human pass" : "Feed the pit"}</button>
      {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
    </div>
  );
}

function HumanGate({ coin, accountId, launch, onPass }: { coin: CoinRef; accountId: string; launch: Launch; onPass: (p: Pass) => void }) {
  const [ch, setCh] = useState<any>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [status, setStatus] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const url = new URL("/api/gate/challenge", PIT_GATE_URL);
      url.searchParams.set("buyer", accountId);
      url.searchParams.set("epoch", String(launch.epoch));
      // The shared gate serves every coin; ask for a pass for this one.
      if (launch.launch?.sale_id) url.searchParams.set("sale", launch.launch.sale_id);
      const r = await fetch(url).then((x) => x.json());
      if (!r.session_id) throw new Error(r.error ?? "gate refused");
      setCh(r);
      setPicked(null);
    } catch (e: any) {
      setStatus({ cls: "err", text: `The gate didn't answer: ${e?.message ?? e}` });
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      setStatus({ cls: "", text: "Proving you're not a farm (proof-of-work)…" });
      const { solvePow } = await import("../lib/pow");
      const sol = solvePow(ch.nonce, BigInt(ch.pow_target));
      const r = await fetch(new URL("/api/gate/verify", PIT_GATE_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: ch.session_id, pow_solution: sol, answer: String(picked) }),
      }).then((x) => x.json());
      if (!r.pass) throw new Error(r.error === "challenge_failed" ? "that wasn't the odd one out" : r.error ?? "no pass");

      // Don't trust the gate: verify the pass ourselves before saving it.
      const { verifyPassSignature } = await import("../lib/simVerify");
      const p = JSON.parse(r.pass);
      if (p.sale !== launch.launch?.sale_id || p.buyer !== accountId) throw new Error("pass is for a different sale or wallet");
      const registry = launch.launch?.agent_registry;
      if (registry && typeof r.agent_id === "string" && /^[0-9a-f]{64}$/.test(r.agent_id)) {
        if (!(await verifyPassSignature(r.pass, r.sig_b64, r.agent_id))) throw new Error("pass signature doesn't match the gate agent's key");
        const agent = await viewMethod<{ validity: unknown } | null>(registry, "get_agent", { account_id: r.agent_id });
        if (agent?.validity !== "Valid") throw new Error("the gate agent isn't a valid attested agent right now");
        onPass({ pass: r.pass, sig_b64: r.sig_b64, verifier: r.verifier?.name ?? "gate agent", agentId: r.agent_id });
        return;
      }
      for (const v of launch.launch?.verifiers ?? []) {
        if (await verifyPassSignature(r.pass, r.sig_b64, v.pubkey_hex)) { onPass({ pass: r.pass, sig_b64: r.sig_b64, verifier: v.name }); return; }
      }
      throw new Error("pass isn't signed by a gate this launch trusts");
    } catch (e: any) {
      setStatus({ cls: "err", text: `${e?.message ?? e}. Try again.` });
      setCh(null);
    } finally {
      setBusy(false);
    }
  };

  if (!ch) {
    return (
      <div className="panel-body">
        <div className="mascot"><PitLogo size={92} /></div>
        <h4>Humans first</h4>
        <p>Epoch {launch.epoch} is humans-only. Pass a quick check to get a one-time pass bound to <b>{accountId}</b>.</p>
        <button className="btn launch wide" disabled={busy || PREVIEW} onClick={start}>{busy ? "Asking the gate…" : "Get human pass"}</button>
        {status && <div className={`notice ${status.cls}`}>{status.text}</div>}
      </div>
    );
  }
  return (
    <div className="panel-body">
      <h4>{ch.challenge.prompt}</h4>
      <p>{ch.challenge.hint}</p>
      <div className="choices">
        {ch.challenge.options.map((o: string, i: number) => (
          <button key={i} aria-pressed={picked === i} onClick={() => setPicked(i)} aria-label={`Option ${i + 1}`}>{o}</button>
        ))}
      </div>
      <button className="btn launch wide" disabled={picked == null || busy} onClick={finish}>{busy ? "Checking…" : "Submit"}</button>
      {status && <div className={`notice ${status.cls}`}>{status.text}</div>}
    </div>
  );
}

function SellTab({ coin, accountId, onDone }: { coin: CoinRef; accountId: string | null; onDone: () => void }) {
  const view = <T,>(m: string, a: object = {}) => viewOf<T>(coin.contract, m, a);
  const [balance, setBalance] = useState<bigint>(0n);
  const [amount, setAmount] = useState("");
  const [quoted, setQuoted] = useState<{ key: string; value: bigint } | null>(null);
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBalance = () => {
    if (!PREVIEW && accountId) view<string>("ft_balance_of", { account_id: accountId }).then((b) => setBalance(BigInt(b))).catch(() => {});
  };
  useEffect(loadBalance, [accountId]);
  const quoteKey = `${coin.contract}:${accountId}:${amount}`;
  const quote = quoted?.key === quoteKey ? quoted.value : null;
  useEffect(() => {
    let active = true;
    setQuoted(null);
    const t = parseTokens(amount);
    if (!t || PREVIEW) return () => { active = false; };
    view<string>("quote_sell", { amount: t.toString() }).then((q) => { if (active) setQuoted({ key: quoteKey, value: BigInt(q) }); }).catch(() => { if (active) setQuoted(null); });
    return () => { active = false; };
  }, [quoteKey]);

  if (!accountId) return <ConnectPrompt text="Climb out of the pit" />;

  const sell = async () => {
    const t = parseTokens(amount);
    if (!t || !quote) return;
    setBusy(true);
    setMsg(null);
    try {
      const minOut = ((quote * 97n) / 100n).toString();
      // The ticket deposit is always returned: with the payout now, or with it later if queued.
      await sendFunctionCall(coin.contract, "sell", { amount: t.toString(), min_near_out: minOut }, 60, TICKET_DEPOSIT.toString());
      setMsg({ cls: "ok", text: "Sale submitted. Your payout claim stays on-chain until its transfer succeeds. If liquidity is staked, the claim waits in the withdrawal queue." });
      setAmount("");
      loadBalance();
      onDone();
    } catch (e: any) {
      setMsg({ cls: "err", text: friendly(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body">
      <div className="field">
        <label htmlFor="sell-amt"><span>You sell</span>
          <button className="linkish" onClick={() => setAmount((Number(balance / 10n ** 12n) / 1e6).toString())}>Balance {tokens(balance)} · max</button>
        </label>
        <div className="row">
          <input id="sell-amt" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${coin.ticker} to sell`} />
          <span className="unit">{coin.ticker}</span>
        </div>
      </div>
      <div className="quote"><span>You get ≈</span><b>{quote != null ? `${near(quote, 4)} NEAR` : "—"}</b></div>
      <div className="quote"><span>Refundable ticket deposit</span><b>{near(TICKET_DEPOSIT, 3)} NEAR</b></div>
      <button className="btn launch wide" disabled={busy || PREVIEW || !quote || balance === 0n} onClick={sell}>{busy ? "Climbing out…" : "Sell"}</button>
      {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
    </div>
  );
}

/** Contract error labels → plain language. */
export function friendly(raw: string): string {
  const map: [string, string][] = [
    ["Slippage", "The price moved more than 3% — try again."],
    ["PassRequired", "This epoch is humans-only. Get a human pass first."],
    ["PassReplay", "That pass was already used. Get a new one."],
    ["PassExpired", "Your pass expired. Get a new one."],
    ["PerBuyerCap", "You've hit this epoch's per-wallet limit."],
    ["PassExceedsAmount", "That's more than your pass allows — buy a bit less."],
    ["DepositBelowStorageCost", "Amount too small to cover setup — add a little more NEAR."],
    ["LaunchNotStarted", "The pit isn't open yet."],
    ["AttachTicketDeposit", "Selling needs the small refundable ticket deposit."],
    ["NotInGatedPhase", "The humans-only window just ended — buy normally now."],
  ];
  return map.find(([k]) => raw.includes(k))?.[1] ?? raw.slice(0, 160);
}

