/**
 * The Pit pairs an optional launch gate with a staked reserve and an AI budget.
 *
 * Routes (hash): #/ home · #/launch create a coin · #/coin/<symbol> trade it ·
 * #/portfolio your positions.
 * Plain #anchors scroll within the current page.
 */
import { useEffect, useMemo, useState } from "react";
import { launchIdFromLogs } from "../lib/transaction-result";
import { CoinPayouts, FactoryRefund } from "./Payouts";
import { connect, EXPLORER, NETWORK, sendFunctionCall, signOut, subscribeAccount } from "../lib/near";
import {
  CoinRecord, CoinRef, coinRef, FEED_ICON, Launch, near, price, SAMPLE_COINS, Stats, tokens, useCoinChain, useFeed, useLaunchpad, viewOf, when, ago,
} from "./chain";
import { PIT_BRAIN_URL, PIT_CONTRACT, PIT_FACTORY, PREVIEW } from "./config";
import { BYTE_COST, iconBytes, imageToIcon, isImageIcon, MAX_ICON_BYTES } from "./icon";
import { CurveChart } from "./Curve";
import { Portfolio } from "./Portfolio";
import { AccountLink, CoinIcon, Ticker } from "./ui";
import { PitLogo } from "./Logo";
import { MindSection } from "./Mind";
import { CrossChainFunding } from "./CrossChainFunding";
import { RNearWallet } from "./RNearWallet";
import { ActionPanel, friendly } from "./Trade";

type Route = { page: "home" } | { page: "launch" } | { page: "portfolio" } | { page: "coin"; symbol: string };

function parseRoute(): Route | null {
  const h = location.hash;
  if (!h.startsWith("#/")) return null; // an in-page anchor, not a route
  const coin = /^#\/coin\/([a-z0-9]{2,10})$/.exec(h);
  if (coin) return { page: "coin", symbol: coin[1] };
  if (h === "#/launch") return { page: "launch" };
  if (h === "#/portfolio") return { page: "portfolio" };
  return { page: "home" };
}

function useRoute(): Route {
  // Single-coin deployments have no launchpad: the coin page is home.
  const initial: Route = !PIT_FACTORY && PIT_CONTRACT ? { page: "coin", symbol: "pit" } : parseRoute() ?? { page: "home" };
  const [route, setRoute] = useState<Route>(initial);
  useEffect(() => {
    const on = () => {
      const r = parseRoute();
      if (r) {
        setRoute(r);
        if (location.hash !== "#/docs") window.scrollTo({ top: 0, behavior: "instant" });
      }
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const LAUNCHING_KEY = "pit-launching";

export default function ThePitApp() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const route = useRoute();
  const pad = useLaunchpad();
  const [walletError, setWalletError] = useState("");
  useEffect(() => (PREVIEW ? undefined : subscribeAccount(setAccountId)), []);
  useEffect(() => {
    if (route.page === "home" && location.hash === "#/docs") {
      document.getElementById("docs")?.scrollIntoView();
    }
  }, [route]);

  // Back from the wallet after launching: open the new coin once it exists.
  useEffect(() => {
    if (!accountId) return;
    let sym: string | null;
    try { sym = localStorage.getItem(LAUNCHING_KEY); } catch { return; }
    if (!sym || PREVIEW || !PIT_FACTORY) return;
    viewOf<CoinRecord | null>(PIT_FACTORY, "get_coin", { symbol: sym }).then((c) => {
      if (c?.creator === accountId) {
        localStorage.removeItem(LAUNCHING_KEY);
        location.hash = `#/coin/${sym}`;
      }
    }).catch(() => {});
  }, [accountId]);

  return (
    <>
      <header className="nav">
        <div className="wrap">
          <a className="brand" href="#/" aria-label="The Pit home">
            <PitLogo size={34} />
            <b>The Pit</b>
          </a>
          {(PIT_FACTORY || PREVIEW) && (
            <nav className="nav-links" aria-label="Sections">
              <a href="#/" aria-current={route.page === "home" ? "page" : undefined}>Pits</a>
              <a href="#/launch" aria-current={route.page === "launch" ? "page" : undefined}>Launch a coin</a>
              <a href="#/portfolio" aria-current={route.page === "portfolio" ? "page" : undefined}>Portfolio</a>
              <a href="#/docs">How it works</a>
            </nav>
          )}
          <div className="nav-right">
            <span className={`status network-chip ${PREVIEW ? "soon" : ""}`}><i aria-hidden />{PREVIEW ? "Preview" : `NEAR ${NETWORK}`}</span>
            {accountId
              ? <button className="btn dark" onClick={() => signOut()} title="Sign out">{accountId.length > 18 ? accountId.slice(0, 16) + "…" : accountId}</button>
              : !PREVIEW && <button className="btn launch" onClick={() => {
                setWalletError("");
                void connect().catch(() => setWalletError("Couldn’t open the wallet selector. Please try again."));
              }}>Connect wallet</button>}
          </div>
        </div>
      </header>

      {PREVIEW && <div className="wrap"><div className="banner preview-banner"><strong>Demo mode</strong><span>Explore sample markets and configure a launch. Wallet transactions are unavailable.</span></div></div>}
      {walletError && <div className="wrap"><div className="banner" role="alert">{walletError}</div></div>}
      {pad.err && <div className="wrap"><div className="banner">{pad.err}</div></div>}

      {route.page === "home" && <Home pad={pad} accountId={accountId} />}
      {route.page === "launch" && <LaunchPage accountId={accountId} pad={pad} />}
      {route.page === "portfolio" && <Portfolio accountId={accountId} coins={pad.coins} />}
      {route.page === "coin" && <CoinPage symbol={route.symbol} accountId={accountId} pad={pad} />}

      {(PIT_FACTORY || PREVIEW) && (
        <nav className="tabbar" aria-label="Sections">
          <a href="#/" aria-current={route.page === "home" ? "page" : undefined}><span aria-hidden>🕳️</span>Pits</a>
          <a href="#/launch" aria-current={route.page === "launch" ? "page" : undefined}><span aria-hidden>🚀</span>Launch</a>
          <a href="#/portfolio" aria-current={route.page === "portfolio" ? "page" : undefined}><span aria-hidden>💼</span>Portfolio</a>
        </nav>
      )}

      <footer className="foot">
        <div className="wrap">
          <span>The Pit · {PREVIEW ? "Interactive preview" : `NEAR ${NETWORK}`}</span>
          {PIT_FACTORY || PIT_CONTRACT
            ? <a href={`${EXPLORER}/address/${PIT_FACTORY || PIT_CONTRACT}`} target="_blank" rel="noreferrer">{PIT_FACTORY || PIT_CONTRACT} ↗</a>
            : <a href="#/docs">How it works ↗</a>}
        </div>
      </footer>
    </>
  );
}

type Pad = ReturnType<typeof useLaunchpad>;

// ————— home —————

function Home({ pad, accountId }: { pad: Pad; accountId: string | null }) {
  const [filter, setFilter] = useState<"all" | "gated" | "open" | "soon">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"new" | "backing" | "fed" | "price">("new");
  const totals = useMemo(() => {
    let backing = 0n, food = 0n;
    for (const [, s] of pad.coins) if (s) { backing += BigInt(s.principal); food += BigInt(s.total_harvested); }
    return { backing, food };
  }, [pad.coins]);
  const q = query.trim().toLowerCase().replace(/^\$/, "");
  const big = (s: Stats | null, k: "principal" | "total_harvested" | "spot_price") => (s ? BigInt(s[k]) : -1n);
  const shown = pad.coins
    .filter(([c, s]) => filter === "all" ? true : filter === "soon" ? s?.phase === "not_started" : s?.phase === filter)
    .filter(([c]) => !q || c.symbol.includes(q) || c.name.toLowerCase().includes(q) || c.creator.includes(q))
    .sort(([a, sa], [b, sb]) => {
      if (sort === "new") return b.created_ms - a.created_ms;
      const k = sort === "backing" ? "principal" : sort === "fed" ? "total_harvested" : "spot_price";
      const d = big(sb, k) - big(sa, k);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
  const cost = pad.config ? BigInt(pad.config.create_cost) : 12n * 10n ** 22n;

  return (
    <main className="wrap" id="top">
      <section className="hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <p className="eyebrow"><span className="hero-dot" aria-hidden /> iMeme launchpad on NEAR</p>
          <h1 id="hero-h">Memecoins with<br /> <span>a mind of their own.</span></h1>
          <p className="sub">Launch a token with an optional early access gate. Staking rewards and trading fees help fund its AI.</p>
          <div className="cta">
            <a className="btn light" href="#/launch">{PREVIEW ? "Try the launch builder" : "Launch a coin"} <span aria-hidden>↗</span></a>
            <a className="btn dark" href="#pits">Explore markets</a>
          </div>
        </div>
        <div className="hero-art" aria-hidden>
          <div className="hero-orbit" />
          <div className="mascot-big"><PitLogo size={236} /></div>
          <span className="art-label">FIG. 01 <span>THE PIT MASCOT</span></span>
        </div>
      </section>

      <div className="tickers">
        <Ticker icon="🕳️" title="Pits" value={pad.loaded ? String(pad.coins.length) : "—"} note="Coins launched so far" />
        <Ticker icon="🔒" title="Backing" value={pad.loaded ? `${near(totals.backing, 0)} Ⓝ` : "—"} note="NEAR in all pits combined" />
        <Ticker icon="🧠" title="Fed" value={pad.loaded ? `${near(totals.food, 2)} Ⓝ` : "—"} tone="brain" note="Brain food eaten, all coins" />
        <Ticker icon="🚀" title="Launch" value={`${near(cost, 2)} Ⓝ`} note="To launch your own coin" />
      </div>

      <section className="section" id="pits" aria-labelledby="pits-h">
        <div className="pits-head">
          <div>
            <p className="eyebrow">{PREVIEW ? "Sample markets" : "NEAR launchpad"}</p>
            <h2 id="pits-h">Explore <span className="hl">markets</span></h2>
          </div>
          <div className="seg" role="group" aria-label="Filter coins">
            {(["all", "gated", "open", "soon"] as const).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "gated" ? "Gated" : f === "open" ? "Open" : "Soon"}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar">
          <label className="search">
            <span aria-hidden>⌕</span>
            <input type="search" placeholder="Search by name, $SYMBOL or creator" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search coins" />
          </label>
          <label className="sort">
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort coins">
              <option value="new">Newest</option>
              <option value="backing">Most NEAR in the pit</option>
              <option value="fed">Best-fed brain</option>
              <option value="price">Highest price</option>
            </select>
          </label>
          <span className="muted">{pad.loaded ? `${shown.length} of ${pad.coins.length}` : ""}</span>
        </div>
        {!pad.loaded ? (
          <div className="coins">{[0, 1, 2].map((i) => <div key={i} className="coin-card skeleton" aria-hidden />)}</div>
        ) : shown.length === 0 ? (
          <div className="empty-card">
            <PitLogo size={72} hungry />
            <p role="status">{pad.coins.length === 0 ? "No coins have launched yet." : "No markets match your search or filter."}</p>
            {pad.coins.length === 0
              ? <a className="btn light" href="#/launch">Launch a coin</a>
              : <button className="btn dark" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button>}
          </div>
        ) : (
          <div className="coins">
            {shown.map(([c, s]) => <CoinCard key={c.symbol} coin={c} stats={s} />)}
          </div>
        )}
      </section>

      <section className="section funding-section" id="funding" aria-labelledby="funding-h">
        <p className="eyebrow">Wallet tools</p>
        <h2 id="funding-h">Fund &amp; stake</h2>
        <CrossChainFunding accountId={accountId} />
        <RNearMarket />
        <RNearWallet accountId={accountId} />
        <FactoryRefund accountId={accountId} />
      </section>

      <section className="section" aria-labelledby="how-h">
        <div className="centered">
          <p className="eyebrow">How the pit works</p>
          <h2 id="how-h">Every coin gets <span className="hl">three things</span></h2>
          <p className="lede">Each coin uses the same contract design: a launch gate, a reserve, and an AI budget. The code has an internal review; an independent audit is still needed for real-money use.</p>
        </div>
        <div className="suite">
          <div className="feature">
            <div className="icon" aria-hidden>🚪</div>
            <h3>An optional launch gate</h3>
            <p>During gated windows, buying needs a one-time, wallet-bound pass. A production Shade Agent would run the gate in a TEE; that path is not active on this preview.</p>
          </div>
          <div className="feature">
            <div className="icon" aria-hidden>🔒</div>
            <h3>A staked reserve</h3>
            <p>Buys follow a bonding curve. The reserve targets 80% in validator staking and 20% liquid for instant sells; larger exits can enter a withdrawal queue.</p>
          </div>
          <div className="feature">
            <div className="icon" aria-hidden>🧠</div>
            <h3>Its own brain</h3>
            <p>Staking rewards and the 1% fee feed the coin's AI. More NEAR in the pit unlocks a bigger model. Creators can take up to half of that food.</p>
          </div>
        </div>
      </section>

      <DocsSection />

      <section className="section" aria-label="Get started">
        <div className="closing">
          <a href="#/launch"><h3>Launch<br />a coin</h3><p>Name it, pick a launch window, choose your cut. One transaction.</p><span className="arrow">→</span></a>
          <a className="alt" href="#pits"><h3>Feed<br />a pit</h3><p>Explore a coin’s reserve, launch window and AI activity.</p><span className="arrow">→</span></a>
        </div>
      </section>
    </main>
  );
}

function RNearMarket() {
  const [market, setMarket] = useState<{ near_per_rnear: string; apy_percent: string; fetched_at_ms: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!PIT_BRAIN_URL) return;
    let alive = true;
    fetch(`${PIT_BRAIN_URL}/api/rnear/market`).then((r) => { if (!r.ok) throw new Error("unavailable"); return r.json(); })
      .then((data) => { if (alive) setMarket(data); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  return <section className="section" aria-label="RHEA liquid staking market">
    <div className="terminal"><div className="term-head"><span>RHEA · rNEAR market</span><span>NEAR MAINNET</span></div>
      <div className="panel-body"><p>Explore RHEA's liquid staking share price and reported APY. The Pit's reserve currently uses validator pools.</p>
        {market ? <p><b>1 rNEAR = {market.near_per_rnear} NEAR</b> · Reported APY: <b>{market.apy_percent}%</b> · Updated {new Date(market.fetched_at_ms).toLocaleTimeString()}</p> : <p className="muted">{failed || !PIT_BRAIN_URL ? "Market data unavailable." : "Loading market data…"}</p>}
        <a href="https://www.rhea.finance/" target="_blank" rel="noreferrer">Learn about rNEAR ↗</a>
      </div></div>
  </section>;
}

function PhaseBadge({ phase }: { phase?: string }) {
  const [cls, text] = phase === "gated" ? ["gated", "Gated"] : phase === "open" ? ["open", "Open"] : phase === "not_started" ? ["soon", "Soon"] : ["", "—"];
  return <span className={`badge ${cls}`}>{text}</span>;
}

function CoinCard({ coin, stats }: { coin: CoinRecord; stats: Stats | null }) {
  return (
    <a className="coin-card" href={`#/coin/${coin.symbol}`}>
      <div className="coin-top">
        <CoinIcon icon={coin.icon} contract={coin.account_id} hasImage={coin.has_image} />
        <div className="coin-name">
          <strong>{coin.name}</strong>
          <small>${coin.symbol.toUpperCase()}</small>
        </div>
        <PhaseBadge phase={stats?.phase} />
      </div>
      <div className="coin-stats">
        <div><small>Price</small><b>{stats ? `${price(stats).toExponential(2)} Ⓝ` : "—"}</b></div>
        <div><small>In the pit</small><b>{stats ? `${near(stats.principal, 0)} Ⓝ` : "—"}</b></div>
        <div><small>Brain</small><b className="brainc">{stats?.tier.name ?? "—"}</b></div>
      </div>
      <span className="coin-go">Trade →</span>
    </a>
  );
}

// ————— launch a coin —————

const ICONS = ["🐶", "🐸", "🐱", "🦍", "🐳", "🦄", "🍄", "🌙", "🔥", "💀", "🤖", "🧠"];
const DELAYS: [string, number][] = [["Now", 0], ["15 min", 15 * 60_000], ["1 hour", 3_600_000], ["24 hours", 86_400_000]];
const WINDOWS: [string, number][] = [["30 min", 30 * 60_000], ["1 hour", 3_600_000], ["6 hours", 6 * 3_600_000]];

function LaunchPage({ accountId, pad }: { accountId: string | null; pad: Pad }) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [icon, setIcon] = useState(ICONS[0]);
  const [upload, setUpload] = useState<{ icon: string; size: number; format: string; name: string } | null>(null);
  const [iconErr, setIconErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [humans, setHumans] = useState(true);
  const [delay, setDelay] = useState(0);
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [cap, setCap] = useState("2000000");
  const [share, setShare] = useState(20);
  const [taken, setTaken] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const gateAvailable = PREVIEW || !!pad.config?.agent_registry || (pad.config?.verifiers.length ?? 0) > 0;
  const symOk = /^[a-z][a-z0-9]{1,9}$/.test(symbol);
  const nameOk = name.trim().length > 0 && name.trim().length <= 32;
  const capOk = /^[1-9]\d{0,12}$/.test(cap);
  // The factory charges storage for every icon byte, which the coin keeps.
  const cost = (pad.config ? BigInt(pad.config.create_cost) : 12n * 10n ** 22n) + BigInt(iconBytes(icon)) * BYTE_COST;

  const takeFile = async (file: File | undefined) => {
    if (!file) return;
    setIconErr(null);
    try {
      const r = await imageToIcon(file);
      setUpload({ ...r, name: file.name });
      setIcon(r.icon);
    } catch (e: any) {
      setIconErr(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    setTaken(null);
    if (!symOk || PREVIEW || !PIT_FACTORY) {
      if (PREVIEW && symOk) setTaken(SAMPLE_COINS.some(([c]) => c.symbol === symbol));
      return;
    }
    const t = setTimeout(() => {
      viewOf<CoinRecord | null>(PIT_FACTORY, "get_coin", { symbol }).then((c) => setTaken(!!c)).catch(() => setTaken(null));
    }, 300);
    return () => clearTimeout(t);
  }, [symbol, symOk]);

  const ready = nameOk && symOk && taken === false && (!humans || capOk) && !!accountId && !PREVIEW;

  const launch = async () => {
    setBusy(true);
    setMsg(null);
    try {
      localStorage.setItem(LAUNCHING_KEY, symbol);
      const outcome = await sendFunctionCall(PIT_FACTORY, "create_coin", {
        symbol,
        name: name.trim(),
        icon,
        launch: humans && gateAvailable
          ? { starts_in_ms: String(delay), epochs: [{ duration_ms: String(windowMs), per_buyer_max_tokens: cap }] }
          : null,
        creator_share_bps: share * 100,
      }, 200, cost.toString(), accountId ?? undefined);
      const launchId = launchIdFromLogs(outcome.logs);
      if (launchId) { try { localStorage.setItem(`pit-launch:${PIT_FACTORY}:${accountId}`, launchId); } catch { /* ID is also in the transaction logs. */ } }
      const c = await viewOf<CoinRecord | null>(PIT_FACTORY, "get_coin", { symbol });
      if (outcome.result === true && c?.creator === accountId) {
        localStorage.removeItem(LAUNCHING_KEY);
        location.hash = `#/coin/${symbol}`;
      } else {
        setMsg({ cls: "warn", text: "The launch failed. The factory retains 0.002 NEAR for recovery storage; the remaining payment is refunded or retained as a retryable claim. Check the launch refund panel below before trying again." });
      }
    } catch (e: any) {
      localStorage.removeItem(LAUNCHING_KEY);
      setMsg({ cls: "err", text: friendly(e?.message ?? String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="wrap">
      <section className="section first" aria-labelledby="launch-h">
        <div className="centered">
          <p className="eyebrow">One transaction · about {near(cost, 2)} NEAR</p>
          <h1 id="launch-h">Build your <span className="hl">iMeme</span></h1>
          <p className="lede">Set your coin’s identity, launch window and share of harvested rewards. Review your settings and estimated cost before signing.</p>
        </div>

        <div className="launch-grid">
          <div className="terminal launch-form">
            <div className="term-head"><span>01 · Configure your coin</span><span>Launch settings</span></div>
            <div className="panel-body">
              <div className="field">
                <label htmlFor="c-name"><span>Name</span><span>{name.trim().length}/32</span></label>
                <div className="row"><input id="c-name" value={name} maxLength={32} placeholder="Doge Pit" onChange={(e) => setName(e.target.value)} /></div>
              </div>
              <div className="field">
                <label htmlFor="c-sym"><span>Symbol</span>
                  <span className={taken ? "bad" : taken === false ? "good" : ""}>
                    {!symbol ? "2–10 letters/digits" : !symOk ? "start with a letter; a–z, 0–9" : taken === null ? "checking…" : taken ? "taken" : "available"}
                  </span>
                </label>
                <div className="row"><span className="unit">$</span><input id="c-sym" value={symbol.toUpperCase()} maxLength={10} placeholder="DOGE" onChange={(e) => setSymbol(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))} /></div>
              </div>
              <div className="field">
                <label><span>Icon</span><span>{isImageIcon(icon) ? `${upload?.size}px ${upload?.format} · ${(iconBytes(icon) / 1024).toFixed(1)} KB on-chain` : "upload an image or pick an emoji"}</span></label>
                <label
                  className={`dropzone${dragging ? " over" : ""}${isImageIcon(icon) ? " has" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); takeFile(e.dataTransfer.files[0]); }}
                >
                  <input type="file" accept="image/*" onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} />
                  {upload ? (
                    <>
                      <img src={upload.icon} alt="Uploaded icon" />
                      <span><b>{upload.name}</b><small>Cropped to a square and compressed to fit on-chain. {isImageIcon(icon) ? "In use." : "Click to use it again."}</small></span>
                      {!isImageIcon(icon) && <button type="button" className="btn dark" onClick={(e) => { e.preventDefault(); setIcon(upload.icon); }}>Use</button>}
                    </>
                  ) : (
                    <span><b>Drop an image here or click to upload</b><small>PNG, JPG, WebP, GIF or SVG. We crop it square and shrink it under {Math.round(MAX_ICON_BYTES / 1024)} KB — it's stored on-chain forever.</small></span>
                  )}
                </label>
                {iconErr && <div className="notice err">{iconErr}</div>}
                <div className="icons" role="group" aria-label="Or pick an emoji">
                  {ICONS.map((i) => (
                    <button key={i} aria-label={`Choose ${i} icon`} aria-pressed={icon === i} onClick={() => setIcon(i)}>{i}</button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label><span>Early access</span><span>{gateAvailable ? "recommended" : "no gate on this launchpad"}</span></label>
                <div className="seg wide" role="group" aria-label="Early access">
                  <button aria-pressed={humans && gateAvailable} disabled={!gateAvailable} onClick={() => setHumans(true)}>Require a pass</button>
                  <button aria-pressed={!humans || !gateAvailable} onClick={() => setHumans(false)}>Open immediately</button>
                </div>
              </div>
              {humans && gateAvailable && (
                <>
                  <div className="field">
                    <label><span>Opens in</span></label>
                    <div className="seg wide">{DELAYS.map(([l, v]) => <button key={l} aria-pressed={delay === v} onClick={() => setDelay(v)}>{l}</button>)}</div>
                  </div>
                  <div className="field">
                    <label><span>Gated window</span><span>then open to everyone</span></label>
                    <div className="seg wide">{WINDOWS.map(([l, v]) => <button key={l} aria-pressed={windowMs === v} onClick={() => setWindowMs(v)}>{l}</button>)}</div>
                  </div>
                  <div className="field">
                    <label htmlFor="c-cap"><span>Max per wallet in that window</span><span>{capOk ? `${Number(cap).toLocaleString()} ${symbol ? symbol.toUpperCase() : "tokens"}` : "whole tokens"}</span></label>
                    <div className="row"><input id="c-cap" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))} /></div>
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="c-share"><span>Your cut of the brain's food</span><b className="mono">{share}%</b></label>
                <input id="c-share" className="range" type="range" min={0} max={50} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} />
                <small className="muted">Of every harvest (staking rewards + fees), {share}% goes to you and {100 - share}% feeds the coin's brain.</small>
              </div>
            </div>
          </div>

          <aside className="terminal launch-preview" aria-label="Preview">
            <div className="term-head"><span>02 · Review launch</span><span>Live preview</span></div>
            <div className="panel-body">
              <div className="coin-card static">
                <div className="coin-top">
                  <CoinIcon icon={icon} />
                  <div className="coin-name"><strong>{name.trim() || "Your coin"}</strong><small>${(symbol || "SYMBOL").toUpperCase()}</small></div>
                  <PhaseBadge phase={humans && gateAvailable ? (delay ? "not_started" : "gated") : "open"} />
                </div>
                <div className="coin-stats">
                  <div><small>Price</small><b>2.80e-6 Ⓝ</b></div>
                  <div><small>In the pit</small><b>0 Ⓝ</b></div>
                  <div><small>Brain</small><b className="brainc">Larva</b></div>
                </div>
              </div>
              <div className="quote"><span>Lives at</span><b>{symbol || "symbol"}.{PIT_FACTORY || `pit.${NETWORK === "mainnet" ? "near" : "testnet"}`}</b></div>
              <div className="quote"><span>Launch cost (coin storage + record{isImageIcon(icon) ? " + image" : ""})</span><b>{near(cost, 3)} NEAR</b></div>
              <div className="quote"><span>Trading fee (feeds the brain)</span><b>1%</b></div>
              {PREVIEW ? <div className="notice warn">Demo mode. You can edit the configuration here. Publishing requires a connected launchpad.</div> : !accountId
                ? <button className="btn launch wide" onClick={() => connect().catch(console.error)}>Connect wallet to launch</button>
                : <button className="btn go wide" disabled={!ready || busy} onClick={launch}>{busy ? "Launching…" : `Launch $${(symbol || "coin").toUpperCase()}`}</button>}
              {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
              <p className="muted small">An asynchronous failed launch retains 0.002 NEAR for refund recovery storage. Remaining funds are returned or kept as a retryable claim.</p>
            </div>
          </aside>
        </div>
      </section>
      <FactoryRefund accountId={accountId} />
    </main>
  );
}

// ————— one coin —————

function CoinPage({ symbol, accountId, pad }: { symbol: string; accountId: string | null; pad: Pad }) {
  const singleCoin = !PIT_FACTORY && !!PIT_CONTRACT;
  const record = pad.coins.find(([c]) => c.symbol === symbol);
  const coin: CoinRef | null = singleCoin
    ? { contract: PIT_CONTRACT, symbol: "pit", ticker: "PIT", name: "The Pit", icon: null }
    : record ? coinRef(record[0]) : null;

  if (!coin) {
    return (
      <main className="wrap">
        <section className="section first">
          <div className="empty-card">
            <PitLogo size={72} hungry />
            <p>{pad.loaded ? `No pit called $${symbol.toUpperCase()} yet.` : "Loading…"}</p>
            {pad.loaded && <a className="btn light" href="#/launch">Launch it yourself</a>}
          </div>
        </section>
      </main>
    );
  }
  return <CoinView coin={coin} accountId={accountId} creator={record?.[0]} fallback={record?.[1] ?? undefined} />;
}

function CoinView({ coin, accountId, creator, fallback }: { coin: CoinRef; accountId: string | null; creator?: CoinRecord; fallback?: Stats }) {
  const { stats, launch, err, refresh } = useCoinChain(coin.contract, fallback);
  const feed = useFeed(coin.symbol);
  const phase = launch?.phase ?? "not_started";
  const statusText = phase === "gated" ? `Gated · window ${(launch?.epoch ?? 0) + 1}` : phase === "open" ? "Open to everyone" : "Launching soon";
  const p = stats ? price(stats) : null;

  return (
    <main className="wrap">
      {err && <div className="banner">{err}</div>}
      <div className="crumbs">{PIT_FACTORY || PREVIEW ? <a href="#/">← All pits</a> : <span />}</div>

      <section className="coin-hero">
        <CoinIcon icon={coin.icon} contract={coin.contract} hasImage={coin.has_image} size={72} />
        <div>
          <h1>{coin.name} <span className="ticker-tag">${coin.ticker}</span></h1>
          <p className="muted">
            {creator ? <>{creator.creator_share_bps / 100}% creator cut · launched {when(creator.created_ms)}</> : "The reserve targets partial validator staking. Harvested rewards and fees help fund this coin’s AI."}
          </p>
          <div className="acct-row">
            <AccountLink id={coin.contract} label="Contract" />
            {creator && <AccountLink id={creator.creator} label="Creator" />}
          </div>
        </div>
        <PhaseBadge phase={phase} />
      </section>

      <div className="tickers">
        <Ticker icon="💱" title={coin.ticker} value={p != null ? `${p.toExponential(2)} Ⓝ` : "—"} note="Price on the bonding curve" />
        <Ticker icon="🔒" title="Backing" value={stats ? `${near(stats.principal, 0)} Ⓝ` : "—"} note="NEAR held in the reserve" />
        <Ticker icon="🧠" title={stats?.tier.name ?? "Brain"} value={stats ? `${near(stats.total_harvested, 2)} Ⓝ` : "—"} tone="brain" note="Confirmed rewards distributed" />
        <Ticker icon="🪙" title="Supply" value={stats ? tokens(stats.total_supply) : "—"} note="Minted on buy, burned on sell" />
      </div>

      <section className="section tight" id="trade" aria-labelledby="trade-h">
        <h2 id="trade-h" className="visually-hidden">Trade {coin.ticker}</h2>
        <div className="terminal">
          <div className="term-bar">
            <span className="mkt"><CoinIcon icon={coin.icon} contract={coin.contract} hasImage={coin.has_image} size={22} />{coin.ticker} / NEAR</span>
            <span className="kv"><small>Price</small><b>{p != null ? p.toExponential(3) : "—"}</b></span>
            <span className="kv"><small>Backing</small><b>{stats ? near(stats.principal) : "—"}</b></span>
            <span className="kv"><small>Instant-sell buffer</small><b>{stats ? near(stats.liquid) : "—"}</b></span>
            <span className="kv"><small>Sell queue</small><b>{stats ? stats.queue_len : "—"}</b></span>
            <span className="kv"><small>Phase</small><b>{statusText}</b></span>
          </div>
          <div className="term-body">
            <div className="term-left">
              <div className="term-head"><span>Bonding curve</span><span>Price vs. supply</span></div>
              <CurveChart contract={coin.contract} stats={stats} />
              <div className="term-head"><span>Recent activity</span><span>from its brain</span></div>
              <ul className="trades">
                {feed.length === 0
                  ? <li className="empty">No recent activity.</li>
                  : feed.map((f, i) => (
                    <li key={i}>
                      <span className="ico" aria-hidden>{FEED_ICON[f.kind] ?? "◆"}</span>
                      <span className={f.kind === "buy" ? "t-buy" : f.kind === "sell" ? "t-sell" : ""}>
                        {(f.kind === "thought" || f.kind === "reply") && <span className="who">@{coin.symbol} </span>}{f.text}
                        {f.proof?.onchain && <a className="proof-tag" href="#mind" title="Signature checked by the contract. Open Verify to confirm the key is NEAR AI's TEE.">✓ proof</a>}
                      </span>
                      <span className="when">{ago(f.at_ms)}</span>
                    </li>
                  ))}
              </ul>
              {stats && <ReserveBar stats={stats} />}
            </div>
            <ActionPanel coin={coin} accountId={accountId} launch={launch} stats={stats} onDone={refresh} />
          </div>
        </div>
      </section>

      <CoinPayouts contract={coin.contract} accountId={accountId} />
      <CrossChainFunding accountId={accountId} />
      <MindSection coin={coin} accountId={accountId} />
      <CoinSuite coin={coin} stats={stats} launch={launch} />
    </main>
  );
}

function CoinSuite({ coin, stats, launch }: { coin: CoinRef; stats: Stats | null; launch: Launch | null }) {
  const l = launch?.launch;
  const pct = stats?.next_tier
    ? Math.min(100, Number(((BigInt(stats.principal) - BigInt(stats.tier.min_principal)) * 1000n) / (BigInt(stats.next_tier.min_principal) - BigInt(stats.tier.min_principal))) / 10)
    : 100;
  let start = l?.starts_at_ms ?? 0;
  return (
    <section className="section" id="brain" aria-labelledby="suite-h">
      <div className="centered">
        <p className="eyebrow">Inside this pit</p>
        <h2 id="suite-h">{coin.name}'s <span className="hl">brain, reserve and gate</span></h2>
      </div>
      <div className="suite">
        <div className="feature">
          <div className="icon" aria-hidden>🧠</div>
          <h3>The brain</h3>
          <p>{stats ? (stats.queue_len > 0 ? "Stressed — sellers are waiting for staked NEAR to return." : BigInt(stats.total_harvested) === 0n ? "Starving — nothing harvested yet." : "Fed and thinking.") : "Loading…"}</p>
          <div className="big">{stats?.tier.name ?? "—"}</div>
          <div className="meter" aria-label="progress to next tier"><div style={{ width: `${pct}%` }} /></div>
          <small>{stats?.next_tier ? `${pct.toFixed(1)}% to ${stats.next_tier.name} at ${near(stats.next_tier.min_principal, 0)} NEAR in the pit` : "Max tier. Galaxy brain."}</small>
        </div>
        <div className="feature">
          <div className="icon" aria-hidden>🔒</div>
          <h3>The reserve</h3>
          <p>Every NEAR paid is principal the curve owes back. 80% is staked with a validator, 20% stays liquid for instant sells. No owner, no admin withdraw, no pause.</p>
          {stats?.creator
            ? <p style={{ marginTop: 12 }}><small>Of each harvest, {stats.creator.share_bps / 100}% goes to the creator ({near(stats.creator_earned ?? "0", 3)} NEAR so far) and the rest feeds the brain.</small></p>
            : <p style={{ marginTop: 12 }}><small>Only staking rewards and the {stats ? stats.fee_bps / 100 : 1}% fee above that reach the brain.</small></p>}
        </div>
        <div className="feature">
          <div className="icon" aria-hidden>🚪</div>
          <h3>The launch gate</h3>
          <p>{!l ? "This coin launched open to everyone — no gated window."
            : l.agent_registry
              ? <>Passes come from a gate running as a NEAR Shade Agent in a TEE; <code>{l.agent_registry}</code> must report it valid on every buy.</>
              : "Passes come from the launch gate; its keys are fixed at launch."}</p>
          {l && (
            <table className="sched">
              <tbody>
                {l.gated_epochs.map((e, i) => {
                  const row = (
                    <tr key={i} className={launch?.phase === "gated" && launch.epoch === i ? "live" : ""}>
                      <td>Window {i + 1} · {when(start)}</td><td>{Number(e.per_buyer_max_tokens).toLocaleString()} {coin.ticker} / wallet</td>
                    </tr>
                  );
                  start = e.ends_at_ms;
                  return row;
                })}
                <tr className={launch?.phase === "open" ? "live" : ""}><td>Open · {when(start)}</td><td>no pass</td></tr>
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}

// ————— shared pieces —————

function ReserveBar({ stats }: { stats: Stats }) {
  const total = BigInt(stats.staked) + BigInt(stats.unstaking) + BigInt(stats.liquid) || 1n;
  const w = (x: string) => `${Number((BigInt(x) * 10000n) / total) / 100}%`;
  return (
    <div className="reserve">
      <small>Where the NEAR sits — holders are always fully backed</small>
      <div className="reserve-bar">
        <div style={{ width: w(stats.staked), background: "#8e3fd6" }} />
        <div style={{ width: w(stats.unstaking), background: "#f7a35c" }} />
        <div style={{ width: w(stats.liquid), background: "#4ade80" }} />
      </div>
      <div className="legend">
        <span><i style={{ background: "#8e3fd6" }} />staked {near(stats.staked)}</span>
        <span><i style={{ background: "#f7a35c" }} />unstaking {near(stats.unstaking)}</span>
        <span><i style={{ background: "#4ade80" }} />instant-sell {near(stats.liquid)}</span>
      </div>
    </div>
  );
}

function DocsSection() {
  const faqs: [string, string][] = [
    ["What is The Pit?", "A NEAR launchpad. Anyone can launch a memecoin here in one transaction. Every coin is bought on a bonding curve, the NEAR behind it is staked with a validator, and the staking rewards plus a 1% trading fee feed that coin's own AI brain."],
    ["What does launching cost?", "About 0.12 NEAR with an emoji icon: 0.1 NEAR becomes the coin's storage float and 0.02 NEAR pays for its record on the launchpad. An uploaded image adds 0.01 NEAR per KB (at most ~0.16 NEAR) because it's stored on-chain forever. Every coin shares one published copy of the code, which is why it's cheap. An asynchronous launch failure retains 0.002 NEAR for refund-claim storage; the remainder is refunded or kept as a retryable claim."],
    ["Can anyone change a coin after launch?", "No. Every coin runs the same code, pinned by its hash. There's no owner, no admin withdraw and no pause — not for us, not for the creator."],
    ["What does the creator get?", "Whatever cut they chose at launch, up to 50% of each harvest (staking rewards + fees). The rest feeds the coin's brain. Holders' backing is never touched."],
    ["Can I always sell?", "Yes. 20% of each pit is kept liquid for instant sells. If a big sell empties that buffer, your sale is locked in at that moment's price and paid as soon as staked NEAR comes back."],
    ["How does the launch gate work?", "During a coin's gated window, buying needs a short-lived pass from the launch gate: the wallet must already exist and hold some NEAR (1 NEAR on mainnet), then solve a quick challenge. Each pass is capped per wallet. This makes running many bot wallets costly; it doesn't prove each buyer is a unique person."],
    ["What are the small extra fees?", "First buy of a coin: ~0.00125 NEAR to set up your token account. Gated buys: 0.002 NEAR for your pass record. Sells: a 0.004 NEAR ticket deposit returned with a successful payout. Some actions also need refund-account storage; excess deposits become withdrawable credit."],
    ["Is it safe?", "The contracts have no admin and can't be upgraded. They passed an internal audit, 75+ contract tests, sandbox end-to-end runs and a 10,000-operation invariant simulation — but no third-party audit yet. Only put in what you can afford to lose."],
    ["What's on-chain about the icon?", "Everything. Images are cropped, shrunk and stored in the coin's own token metadata as PNG/JPEG/WebP/GIF under 16 KB. SVGs and links to remote images are refused, so an icon can't run scripts or track viewers."],
  ];
  return (
    <section className="section" id="docs" aria-labelledby="docs-h">
      <div className="centered">
        <p className="eyebrow">Docs</p>
        <h2 id="docs-h">Questions from the <span className="hl">rim</span></h2>
      </div>
      <div className="faq">
        {faqs.map(([q, a]) => (
          <details key={q}><summary>{q}</summary><p>{a}</p></details>
        ))}
      </div>
    </section>
  );
}
