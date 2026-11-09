/** Your positions across every pit: balance, what it sells for now, and creator earnings. */
import { useEffect, useState } from "react";
import { connect } from "../lib/near";
import { CoinRecord, near, Stats, tokens, viewOf } from "./chain";
import { PREVIEW } from "./config";
import { PitLogo } from "./Logo";
import { CoinIcon, Ticker } from "./ui";

type Row = { coin: CoinRecord; stats: Stats | null; balance: bigint; value: bigint };

export function Portfolio({ accountId, coins }: { accountId: string | null; coins: [CoinRecord, Stats | null][] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = coins.map(([c]) => c.symbol).join(",");

  useEffect(() => {
    if (!accountId || PREVIEW) return;
    let live = true;
    setRows(null);
    Promise.all(
      coins.map(async ([coin, stats]) => {
        const balance = BigInt(await viewOf<string>(coin.account_id, "ft_balance_of", { account_id: accountId }).catch(() => "0"));
        const value = balance > 0n ? BigInt(await viewOf<string>(coin.account_id, "quote_sell", { amount: balance.toString() }).catch(() => "0")) : 0n;
        return { coin, stats, balance, value };
      }),
    ).then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, [accountId, key]);

  if (!accountId) {
    return (
      <main className="wrap">
        <section className="section first">
          <h1>Portfolio</h1>
          <div className="empty-card">
            <PitLogo size={72} hungry />
            <p>{PREVIEW ? "Balances and creator earnings appear here when the launchpad is connected." : "Connect a NEAR wallet to see your balances, estimated sell values and creator earnings."}</p>
            {PREVIEW
              ? <a className="btn dark" href="#/">Explore sample markets</a>
              : <button className="btn launch" onClick={() => connect().catch(console.error)}>Connect wallet</button>}
          </div>
        </section>
      </main>
    );
  }

  const held = (rows ?? []).filter((r) => r.balance > 0n).sort((a, b) => (b.value > a.value ? 1 : -1));
  const created = coins.filter(([c]) => c.creator === accountId);
  const total = held.reduce((s, r) => s + r.value, 0n);
  const earned = created.reduce((s, [, st]) => s + BigInt(st?.creator_earned ?? "0"), 0n);

  return (
    <main className="wrap">
      <section className="section first" aria-labelledby="pf-h">
        <div className="pits-head">
          <div>
            <p className="eyebrow">{accountId}</p>
            <h2 id="pf-h">Your <span className="hl">positions</span></h2>
          </div>
        </div>
        <div className="tickers">
          <Ticker icon="💼" title="Worth" value={rows ? `${near(total, 3)} Ⓝ` : "—"} note="If you sold everything now, after fees" />
          <Ticker icon="🪙" title="Held" value={rows ? String(held.length) : "—"} note={`Coins held, of ${coins.length} pits`} />
          <Ticker icon="🚀" title="Launched" value={String(created.length)} note="Coins you created" />
          <Ticker icon="🍽️" title="Earned" value={`${near(earned, 4)} Ⓝ`} tone="brain" note="Your creator cut, already paid" />
        </div>

        <div className="terminal table-card">
          <div className="term-head"><span>Holdings</span><span>{rows ? `${held.length} coin${held.length === 1 ? "" : "s"}` : "loading…"}</span></div>
          {rows && held.length === 0 ? (
            <p className="muted pad">You don't hold any pit coins yet. <a href="#/">Browse pits →</a></p>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead><tr><th>Coin</th><th className="num">Balance</th><th className="num">Share of supply</th><th className="num">Sells for</th><th>Brain</th><th /></tr></thead>
                <tbody>
                  {(rows ? held : []).map(({ coin, stats, balance, value }) => (
                    <tr key={coin.symbol}>
                      <td><span className="cell-coin"><CoinIcon icon={coin.icon} contract={coin.account_id} hasImage={coin.has_image} size={28} /><b>{coin.name}</b><small>${coin.symbol.toUpperCase()}</small></span></td>
                      <td className="num mono">{tokens(balance)}</td>
                      <td className="num mono">{stats && BigInt(stats.total_supply) > 0n ? `${(Number((balance * 1_000_000n) / BigInt(stats.total_supply)) / 10_000).toFixed(2)}%` : "—"}</td>
                      <td className="num mono">{near(value, 4)} Ⓝ</td>
                      <td className="brainc">{stats?.tier.name ?? "—"}</td>
                      <td className="num"><a className="btn dark sm" href={`#/coin/${coin.symbol}`}>Trade</a></td>
                    </tr>
                  ))}
                  {!rows && <tr><td colSpan={6} className="muted">Reading balances…</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {created.length > 0 && (
          <div className="terminal table-card">
            <div className="term-head"><span>Coins you launched</span><span>your cut is fixed forever</span></div>
            <div className="table-scroll">
              <table className="data">
                <thead><tr><th>Coin</th><th className="num">Your cut</th><th className="num">Earned</th><th className="num">In the pit</th><th className="num">Brain fed</th></tr></thead>
                <tbody>
                  {created.map(([coin, st]) => (
                    <tr key={coin.symbol}>
                      <td><a className="cell-coin" href={`#/coin/${coin.symbol}`}><CoinIcon icon={coin.icon} contract={coin.account_id} hasImage={coin.has_image} size={28} /><b>{coin.name}</b><small>${coin.symbol.toUpperCase()}</small></a></td>
                      <td className="num mono">{coin.creator_share_bps / 100}%</td>
                      <td className="num mono">{near(st?.creator_earned ?? "0", 4)} Ⓝ</td>
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
