/** Your positions across every pit: balance, what it sells for now, and creator earnings. */
import { useEffect, useState } from "react";
import { CoinRecord, near, Stats, tokens, viewOf } from "./chain";
import { PREVIEW } from "./config";
import { PitLogo } from "./Logo";
import { CoinIcon, ConnectWalletButton, Ticker } from "./ui";

type Position = { balance: bigint | null; value: bigint | null };

export function Portfolio({ accountId, coins, marketsLoaded, marketsUnavailable }: {
  accountId: string | null;
  coins: [CoinRecord, Stats | null][];
  marketsLoaded: boolean;
  marketsUnavailable: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ accountId: string; key: string; positions: Map<string, Position> } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = coins.map(([coin]) => coin.account_id).join(",");

  useEffect(() => {
    if (!accountId || PREVIEW || !marketsLoaded || marketsUnavailable) return;
    let active = true;
    const contracts = key ? key.split(",") : [];
    void Promise.all(contracts.map(async (contract): Promise<[string, Position]> => {
      const balance = await viewOf<string>(contract, "ft_balance_of", { account_id: accountId }).then(BigInt).catch(() => null);
      const value = balance === null ? null : balance === 0n ? 0n
        : await viewOf<string>(contract, "quote_sell", { amount: balance.toString() }).then(BigInt).catch(() => null);
      return [contract, { balance, value }];
    })).then((entries) => {
      if (active) setSnapshot({ accountId, key, positions: new Map(entries) });
    });
    return () => { active = false; };
  }, [accountId, key, marketsLoaded, marketsUnavailable, retry]);

  if (!accountId) {
    return (
      <main className="wrap" id="main-content" tabIndex={-1}>
        <section className="section first">
          <h1>Portfolio</h1>
          <div className="empty-card">
            <PitLogo size={72} hungry />
            <p>{PREVIEW ? "Balances and creator earnings appear here when the launchpad is connected." : "Connect a NEAR wallet to see your balances, estimated sell values and creator earnings."}</p>
            {PREVIEW
              ? <a className="btn dark" href="#/">Explore sample markets</a>
              : <ConnectWalletButton />}
          </div>
        </section>
      </main>
    );
  }

  const positions = !marketsUnavailable && snapshot?.accountId === accountId && snapshot?.key === key ? snapshot.positions : null;
  const held = coins.flatMap(([coin, stats]) => {
    const position = positions?.get(coin.account_id);
    return position?.balance && position.balance > 0n ? [{ coin, stats, balance: position.balance, value: position.value }] : [];
  }).sort((a, b) => (b.value ?? -1n) > (a.value ?? -1n) ? 1 : (b.value ?? -1n) < (a.value ?? -1n) ? -1 : 0);
  const incomplete = positions !== null && Array.from(positions.values()).some((position) => position.balance === null);
  const unpriced = held.some((row) => row.value === null);
  const created = coins.filter(([coin]) => coin.creator === accountId);
  const total = held.reduce((sum, row) => sum + (row.value ?? 0n), 0n);
  const earned = created.reduce((s, [, st]) => s + BigInt(st?.creator_earned ?? "0"), 0n);

  return (
    <main className="wrap" id="main-content" tabIndex={-1}>
      <section className="section first" aria-labelledby="pf-h">
        <div className="pits-head">
          <div>
            <p className="eyebrow">{accountId}</p>
            <h1 id="pf-h">Your <span className="hl">positions</span></h1>
          </div>
        </div>
        <div className="tickers">
          <Ticker icon="💼" title="Worth" value={positions && !incomplete && !unpriced ? `${near(total, 3)} Ⓝ` : "—"} note="If you sold everything now, after fees" />
          <Ticker icon="🪙" title="Held" value={positions && !incomplete ? String(held.length) : "—"} note={`Coins held, of ${coins.length} pits`} />
          <Ticker icon="🚀" title="Launched" value={marketsLoaded && !marketsUnavailable ? String(created.length) : "—"} note="Coins you created" />
          <Ticker icon="🍽️" title="Earned" value={marketsLoaded && !marketsUnavailable && created.every(([, stats]) => stats !== null) ? `${near(earned, 4)} Ⓝ` : "—"} tone="brain" note="Your creator cut, already paid" />
        </div>

        <div className="terminal table-card">
          <div className="term-head"><span>Holdings</span><span>{marketsUnavailable ? "Unavailable" : positions ? `${held.length} shown` : "Loading…"}</span></div>
          {marketsUnavailable && <p className="muted pad" role="status">The market list is unavailable. The app will retry automatically.</p>}
          {(incomplete || unpriced) && <div className="pad">
            <p role="status">Some balances or sell estimates couldn’t be loaded.</p>
            <button className="btn dark sm" onClick={() => { setSnapshot(null); setRetry((n) => n + 1); }}>Retry holdings</button>
          </div>}
          {positions && !incomplete && held.length === 0 ? (
            <p className="muted pad">You don't hold any pit coins yet. <a href="#/">Browse pits →</a></p>
          ) : !marketsUnavailable && (!positions || held.length > 0) && (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Holdings table">
              <table className="data">
                <thead><tr><th>Coin</th><th className="num">Balance</th><th className="num">Share of supply</th><th className="num">Sells for</th><th>Brain</th><th /></tr></thead>
                <tbody>
                  {held.map(({ coin, stats, balance, value }) => (
                    <tr key={coin.symbol}>
                      <td><span className="cell-coin"><CoinIcon icon={coin.icon} contract={coin.account_id} hasImage={coin.has_image} size={28} /><b>{coin.name}</b><small>${coin.symbol.toUpperCase()}</small></span></td>
                      <td className="num mono">{tokens(balance)}</td>
                      <td className="num mono">{stats && BigInt(stats.total_supply) > 0n ? `${(Number((balance * 1_000_000n) / BigInt(stats.total_supply)) / 10_000).toFixed(2)}%` : "—"}</td>
                      <td className="num mono">{value === null ? "—" : `${near(value, 4)} Ⓝ`}</td>
                      <td className="brainc">{stats?.tier.name ?? "—"}</td>
                      <td className="num"><a className="btn dark sm" href={`#/coin/${coin.symbol}`}>Trade</a></td>
                    </tr>
                  ))}
                  {!positions && <tr><td colSpan={6} className="muted">Reading balances…</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {created.length > 0 && (
          <div className="terminal table-card">
            <div className="term-head"><span>Coins you launched</span><span>your cut is fixed forever</span></div>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Launched coins table">
              <table className="data">
                <thead><tr><th>Coin</th><th className="num">Your cut</th><th className="num">Earned</th><th className="num">In the pit</th><th className="num">Brain fed</th></tr></thead>
                <tbody>
                  {created.map(([coin, st]) => (
                    <tr key={coin.symbol}>
                      <td><a className="cell-coin" href={`#/coin/${coin.symbol}`}><CoinIcon icon={coin.icon} contract={coin.account_id} hasImage={coin.has_image} size={28} /><b>{coin.name}</b><small>${coin.symbol.toUpperCase()}</small></a></td>
                      <td className="num mono">{coin.creator_share_bps / 100}%</td>
                      <td className="num mono">{st ? `${near(st.creator_earned ?? "0", 4)} Ⓝ` : "—"}</td>
                      <td className="num mono">{st ? `${near(st.principal, 0)} Ⓝ` : "—"}</td>
                      <td className="num mono">{st ? `${near(st.total_harvested, 3)} Ⓝ` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="muted small">Tokens you've locked behind memories are held by the coin contract until you unback them, so they don't show here.</p>
      </section>
    </main>
  );
}
