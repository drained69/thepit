/** Order ticket for one coin: buy (with an early access pass while gated), sell, gate flow. */
import { useEffect, useMemo, useState } from "react";
import { EXPLORER, NETWORK, parseNearAmount, sendFunctionCall, viewMethod } from "./lib/near";
import { PIT_GATE_URL, PREVIEW } from "./config";
import { ConnectWalletButton } from "./ui";
import { PitLogo } from "./Logo";
import {
  CoinRef, Launch, near, parseTokens, Pass, PASS_STORAGE_FEE, SAMPLE_STATS, Stats, TICKET_DEPOSIT, TOKEN, tokens, viewOf, when,
} from "./chain";


export function ActionPanel({ coin, accountId, launch, stats, statsStale, onDone }: { coin: CoinRef; accountId: string | null; launch: Launch | null; stats: Stats | null; statsStale: boolean; onDone: () => void }) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  return (
    <div className="panel">
      <div className="tabs" role="group" aria-label="Order side">
        <button className="buy" aria-pressed={tab === "buy"} onClick={() => setTab("buy")}>Buy</button>
        <button className="sell" aria-pressed={tab === "sell"} onClick={() => setTab("sell")}>Sell</button>
      </div>
      {tab === "buy"
        ? <BuyTab key={accountId} coin={coin} accountId={accountId} launch={launch} stats={stats} onDone={onDone} />
        : <SellTab key={accountId} coin={coin} accountId={accountId} stats={stats} statsStale={statsStale} onDone={onDone} />}
      <div className="panel-foot">
        <a href="#/docs">How does the pit work?</a>
      </div>
    </div>
  );
}

type TradeMessage = { cls: string; text: string; hash?: string; ticketId?: number };

function TradeNotice({ message }: { message: TradeMessage }) {
  return (
    <div className={`notice ${message.cls}`} role="status">
      {message.text}
      {message.hash && <> <a href={`${EXPLORER}/txns/${encodeURIComponent(message.hash)}`} target="_blank" rel="noreferrer">View transaction ↗</a></>}
      {message.ticketId !== undefined && <> · <a href="#payouts">Find sell ticket #{message.ticketId}</a></>}
    </div>
  );
}

function ConnectPrompt({ text }: { text: string }) {
  return (
    <div className="panel-body">
      <div className="mascot"><PitLogo size={92} /></div>
      <h4>{text}</h4>
      <p>{PREVIEW ? "Sample market. Wallet transactions are unavailable in demo mode." : `Connect a NEAR ${NETWORK === "mainnet" ? "" : "testnet "}wallet to trade.`}</p>
      {!PREVIEW && <ConnectWalletButton className="btn launch wide" />}
    </div>
  );
}

function BuyTab({ coin, accountId, launch, stats, onDone }: { coin: CoinRef; accountId: string | null; launch: Launch | null; stats: Stats | null; onDone: () => void }) {
  const view = <T,>(m: string, a: object = {}) => viewOf<T>(coin.contract, m, a);
  const PASS_KEY = `pit-pass:${coin.contract}`;
  const [amount, setAmount] = useState("1");
  const [quoted, setQuoted] = useState<{ key: string; value: bigint } | null>(null);
  const [registration, setRegistration] = useState<{ key: string; registered: boolean; cost: bigint; refundRegistered: boolean; refundCost: bigint } | null>(null);
  const [pass, setPass] = useState<Pass | null>(() => {
    try { return JSON.parse(localStorage.getItem(PASS_KEY) ?? "null"); } catch { return null; }
  });
  const [msg, setMsg] = useState<TradeMessage | null>(null);
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
      view<object | null>("get_refund_credit", { account_id: accountId }),
      view<string>("refund_registration_deposit"),
    ]).then(([b, s, credit, refundCost]) => { if (!b) throw new Error("missing storage bounds"); if (active) setRegistration({ key: registrationKey, cost: BigInt(b.min), registered: !!s, refundRegistered: !!credit, refundCost: BigInt(refundCost) }); })
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

  if (!accountId) return <ConnectPrompt text={gated ? "Early access" : `Throw NEAR in ${coin.name}`} />;

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
    return <>
      <EarlyAccessGate coin={coin} accountId={accountId} launch={launch!} onPass={(p) => {
        setPass(p);
        try { localStorage.setItem(PASS_KEY, JSON.stringify(p)); } catch { /* Storage is optional. */ }
      }} />
      {msg && <div className="panel-body"><TradeNotice message={msg} /></div>}
    </>;
  }

  const buy = async () => {
    const y = parseNearAmount(amount);
    if (!y || !quote || overCap || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const minOut = ((quote * 97n) / 100n).toString(); // 3% slippage guard
      let trade: Awaited<ReturnType<typeof sendFunctionCall>>;
      if (gated && pass?.agentId) {
        if (!currentRegistration?.refundRegistered) {
          if (!currentRegistration) throw Error("Refund registration is still loading");
          await sendFunctionCall(coin.contract, "register_refund_account", {}, 40, currentRegistration.refundCost.toString(), accountId);
          setRegistration({...currentRegistration, refundRegistered:true});
        }
        trade = await sendFunctionCall(coin.contract, "buy_with_agent_pass", { pass: pass.pass, sig_b64: pass.sig_b64, agent_id: pass.agentId, min_tokens_out: minOut }, 120, y.toString(), accountId);
      } else if (gated && pass) {
        trade = await sendFunctionCall(coin.contract, "buy_with_pass", { pass: pass.pass, sig_b64: pass.sig_b64, min_tokens_out: minOut }, 60, y.toString(), accountId);
      } else {
        trade = await sendFunctionCall(coin.contract, "buy", { min_tokens_out: minOut }, 60, y.toString(), accountId);
      }
      if (gated) {
        setPass(null);
        try { localStorage.removeItem(PASS_KEY); } catch { /* Storage is optional. */ }
      }
      const got = typeof trade.result === "string" && /^\d+$/.test(trade.result) ? BigInt(trade.result) : null;
      const refunded = gated && !!pass?.agentId && got === 0n;
      const text = got !== null && got > 0n
        ? `Bought ${tokens(got)} ${coin.ticker} with ${amount} NEAR.`
        : refunded
          ? "The gated buy could not settle. Withdraw your payment from Your payouts and refunds."
          : "Transaction confirmed. Check the receipt for the buy outcome.";
      setMsg({ cls: refunded ? "warn" : "ok", text, hash: trade.transactionHash });
      window.dispatchEvent(new Event("pit-payout-update"));
      onDone();
    } catch (e: any) {
      setMsg({ cls: "err", text: friendly(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  };

  // The contract refunds (as credit) any pass buy that mints more than the pass
  // allows, so stop it here and suggest an amount that fits.
  const passCap = gated && passData ? (() => { try { return BigInt(passData.max_amount) * TOKEN; } catch { return null; } })() : null;
  const spendY = parseNearAmount(amount);
  const overCap = passCap != null && quote != null && quote > passCap;
  const fitsNear = overCap && spendY ? (spendY * passCap! * 95n) / quote! / 100n : null;

  return (
    <div className="panel-body">
      {gated && passData && (
        <div className="notice ok">✓ Early access pass ready · up to {Number(passData.max_amount).toLocaleString()} {coin.ticker} · {pass!.agentId ? "signed by a verified gate agent" : `signed by ${pass!.verifier}`} · expires {new Date(passData.expires_at_ms).toLocaleTimeString()}</div>
      )}
      <div className="field">
        <label htmlFor="buy-amt"><span>You throw in</span><span>{stats ? `${stats.fee_bps / 100}% trading fee` : ""}</span></label>
        <div className="row">
          <input id="buy-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="NEAR to spend" />
          <span className="unit">NEAR</span>
        </div>
      </div>
      <div className="quote"><span>You get ≈</span><b>{quote != null ? `${tokens(quote)} ${coin.ticker}` : "—"}</b></div>
      {!registered && <div className="quote"><span>One-time account setup</span><b>{near(regCost, 5)} NEAR</b></div>}
      {gated && pass?.agentId && currentRegistration && !currentRegistration.refundRegistered && <div className="notice">First agent purchase needs an additional {near(currentRegistration.refundCost, 4)} NEAR refund-account deposit in a separate wallet transaction. Actual storage stays registered; any excess becomes withdrawable credit.</div>}
      {overCap && (
        <div className="notice warn">
          That's more than your pass allows ({Number(passData.max_amount).toLocaleString()} {coin.ticker}).
          {fitsNear != null && fitsNear > 0n && <> <button type="button" className="link" onClick={() => setAmount(near(fitsNear, 3).replace(/,/g, ""))}>Use {near(fitsNear, 3)} NEAR</button></>}
        </div>
      )}
      {gated && <div className="quote"><span>Pass record fee</span><b>{near(PASS_STORAGE_FEE, 3)} NEAR</b></div>}
      <button className="btn go wide" disabled={busy || PREVIEW || !quote || overCap || (phase !== "gated" && phase !== "open")} onClick={buy}>{busy ? "Submitting buy…" : gated ? "Buy with pass" : `Buy ${coin.ticker}`}</button>
      {msg && <TradeNotice message={msg} />}
    </div>
  );
}

function EarlyAccessGate({ coin, accountId, launch, onPass }: { coin: CoinRef; accountId: string; launch: Launch; onPass: (p: Pass) => void }) {
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
      if (!r.session_id) throw new Error(friendly(r.error ?? "gate refused"));
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
      const { solvePow } = await import("./lib/pow");
      const sol = solvePow(ch.nonce, BigInt(ch.pow_target));
      const r = await fetch(new URL("/api/gate/verify", PIT_GATE_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: ch.session_id, pow_solution: sol, answer: String(picked) }),
      }).then((x) => x.json());
      if (!r.pass) throw new Error(r.error === "challenge_failed" ? "that wasn't the odd one out" : r.error ?? "no pass");

      // Don't trust the gate: verify the pass ourselves before saving it.
      const { verifyPassSignature } = await import("./lib/passSignature");
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
        <h4>Early access</h4>
        <p>Complete the check for a one-time pass bound to <b>{accountId}</b>.</p>
        <button className="btn launch wide" disabled={busy || PREVIEW} onClick={start}>{busy ? "Asking the gate…" : "Get early access pass"}</button>
        {status && <div className={`notice ${status.cls}`}>{status.text}</div>}
      </div>
    );
  }
  return (
    <div className="panel-body">
      <h4>{ch.challenge.prompt}</h4>
      <div className="choices">
        {ch.challenge.options.map((o: string, i: number) => (
          <button key={i} aria-pressed={picked === i} onClick={() => setPicked(i)} aria-label={`Option ${i + 1}: ${o}`}>{o}</button>
        ))}
      </div>
      <button className="btn launch wide" disabled={picked == null || busy} onClick={finish}>{busy ? "Checking…" : "Submit"}</button>
      {status && <div className={`notice ${status.cls}`}>{status.text}</div>}
    </div>
  );
}

function SellTab({ coin, accountId, stats, statsStale, onDone }: { coin: CoinRef; accountId: string | null; stats: Stats | null; statsStale: boolean; onDone: () => void }) {
  const view = <T,>(m: string, a: object = {}) => viewOf<T>(coin.contract, m, a);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const [amount, setAmount] = useState("");
  const [quoted, setQuoted] = useState<{ key: string; value: bigint } | null>(null);
  const [msg, setMsg] = useState<TradeMessage | null>(null);
  const [busy, setBusy] = useState(false);

  const [balanceVersion, setBalanceVersion] = useState(0);
  useEffect(() => {
    if (PREVIEW || !accountId) return;
    let active = true;
    setBalance(null);
    setBalanceError(false);
    void view<string>("ft_balance_of", { account_id: accountId })
      .then((b) => { if (active) setBalance(BigInt(b)); })
      .catch(() => { if (active) setBalanceError(true); });
    return () => { active = false; };
  }, [accountId, coin.contract, balanceVersion]);
  const sellAmount = parseTokens(amount);
  const overBalance = balance !== null && sellAmount !== null && sellAmount > balance;
  const quoteKey = `${coin.contract}:${accountId}:${amount}:${stats?.principal}:${stats?.total_supply}`;
  const quote = quoted?.key === quoteKey ? quoted.value : null;
  useEffect(() => {
    let active = true;
    setQuoted(null);
    if (!sellAmount || balance === null || overBalance || PREVIEW) return () => { active = false; };
    view<string>("quote_sell", { amount: sellAmount.toString() }).then((q) => { if (active) setQuoted({ key: quoteKey, value: BigInt(q) }); }).catch(() => { if (active) setQuoted(null); });
    return () => { active = false; };
  }, [quoteKey, balance, overBalance]);

  if (!accountId) return <ConnectPrompt text="Climb out of the pit" />;

  const sell = async () => {
    if (!sellAmount || !quote || balance === null || overBalance || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const minOut = ((quote * 97n) / 100n).toString();
      // The ticket deposit is always returned: with the payout now, or with it later if queued.
      const sale = await sendFunctionCall(coin.contract, "sell", { amount: sellAmount.toString(), min_near_out: minOut }, 60, TICKET_DEPOSIT.toString(), accountId);
      const result = sale.result as { status?: unknown; ticket_id?: unknown } | null;
      const id = result?.ticket_id;
      const ticketId = typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
      if (ticketId !== undefined) {
        try { localStorage.setItem(`pit-ticket:${coin.contract}:${accountId}`, String(ticketId)); } catch { /* The on-chain claim remains accessible by ticket ID. */ }
      }
      const text = result?.status === "queued"
        ? "Sale confirmed. Your payout is queued at the sale price."
        : result?.status === "paying"
          ? "Sale confirmed. The contract started your payout transfer."
          : "Sale confirmed. Check the transaction receipt for payout details.";
      setMsg({ cls: "ok", text, hash: sale.transactionHash, ticketId });
      setAmount("");
      setBalanceVersion((version) => version + 1);
      window.dispatchEvent(new Event("pit-payout-update"));
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
          <button type="button" className="linkish" disabled={!balance} onClick={() => {
            if (!balance) return;
            const fraction = (balance % TOKEN).toString().padStart(18, "0").replace(/0+$/, "");
            setAmount(`${balance / TOKEN}${fraction ? `.${fraction}` : ""}`);
          }}>{balance === null ? "Balance —" : `Balance ${tokens(balance)} · max`}</button>
        </label>
        <div className="row">
          <input id="sell-amt" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${coin.ticker} to sell`} />
          <span className="unit">{coin.ticker}</span>
        </div>
      </div>
      {balanceError && <div className="notice err" role="status">Could not read your token balance. <button className="link" type="button" onClick={() => setBalanceVersion((version) => version + 1)}>Retry</button></div>}
      <div className="quote"><span>You get ≈</span><b>{quote != null ? `${near(quote, 4)} NEAR` : "—"}</b></div>
      {overBalance && <div className="notice warn" role="status">This amount exceeds your token balance.</div>}
      {quote !== null && quote > 0n && stats && !statsStale && (
        <div className="notice" role="status">
          {stats.queue_len > 0 || quote > BigInt(stats.liquid)
            ? "Expected payout: queued at the sale price."
            : "Expected payout: transfer starts when the sale settles."}
          {" "}Liquidity and queue status can change before confirmation.
        </div>
      )}
      <div className="quote"><span>Refundable ticket deposit</span><b>{near(TICKET_DEPOSIT, 3)} NEAR</b></div>
      <button className="btn sell-order wide" disabled={busy || PREVIEW || !quote || balance === null || overBalance} onClick={sell}>{busy ? "Submitting sell…" : `Sell ${coin.ticker}`}</button>
      {msg && <TradeNotice message={msg} />}
    </div>
  );
}

/** Contract error labels → plain language. */
export function friendly(raw: string): string {
  const map: [string, string][] = [
    ["Slippage", "The price moved more than 3% — try again."],
    ["PassRequired", "This window requires an early access pass."],
    ["PassReplay", "That pass was already used. Get a new one."],
    ["PassExpired", "Your pass expired. Get a new one."],
    ["PerBuyerCap", "You've hit this epoch's per-wallet limit."],
    ["PassExceedsAmount", "That's more than your pass allows — buy a bit less."],
    ["DepositBelowStorageCost", "Amount too small to cover setup — add a little more NEAR."],
    ["LaunchNotStarted", "The pit isn't open yet."],
    ["AttachTicketDeposit", "Selling needs the small refundable ticket deposit."],
    ["NotInGatedPhase", "The gated window ended. Buying is now open."],
    ["buyer_balance_too_low", "The early window is for established wallets: this one needs to hold at least 1 NEAR first."],
    ["buyer_account_not_found", "This wallet doesn't exist on-chain yet. Fund it, then try again."],
    ["eligibility_unavailable", "The gate couldn't check your wallet just now. Try again in a moment."],
    ["gate_busy", "The gate is busy. Try again in a few seconds."],
    ["too_many_open_challenges", "Too many open challenges from your connection. Wait a minute and try again."],
  ];
  return map.find(([k]) => raw.includes(k))?.[1] ?? raw.slice(0, 160);
}

