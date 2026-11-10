/**
 * The coin's bonding curve, drawn exactly from the contract's `curve_info`:
 * NEAR reserve (virtual + principal) × token reserve (virtual − supply) = constant,
 * so the price at P NEAR in the pit is (vN + P)² / (vN · vT).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PREVIEW } from "./config";
import { near, Stats, viewOf } from "./chain";

type CurveInfo = [string, string, string, string, number];

const fmtP = (p: number) => (p >= 0.01 ? p.toFixed(4) : p.toExponential(2));
const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : n.toFixed(n >= 10 ? 0 : 1));

export function CurveChart({ contract, stats }: { contract: string; stats: Stats | null }) {
  const [info, setInfo] = useState<CurveInfo | null>(PREVIEW ? ["3000000000000000000000000000", "1073000000000000000000000000", "0", "0", 100] : null);
  const [unavailable, setUnavailable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [scenario, setScenario] = useState<number | null>(null);
  const sliderId = useId();
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (PREVIEW) return;
    let active = true;
    const load = () => {
      void viewOf<CurveInfo>(contract, "curve_info").then(
        (value) => { if (active) { setInfo(value); setUnavailable(false); } },
        () => { if (active) setUnavailable(true); },
      );
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [contract]);

  const vN = info ? Number(BigInt(info[0]) / 10n ** 18n) / 1e6 : 3000;
  const vT = info ? Number(BigInt(info[1]) / 10n ** 12n) / 1e6 : 1.073e9;
  const P = stats ? Number(BigInt(stats.principal) / 10n ** 18n) / 1e6 : 0;
  const priceAt = (x: number) => ((vN + x) * (vN + x)) / (vN * vT);
  const supplyAt = (x: number) => vT - (vN * vT) / (vN + x);
  const tiers = [stats?.tier, stats?.next_tier].filter(Boolean).map((t) => ({ name: t!.name, at: Number(BigInt(t!.min_principal) / 10n ** 18n) / 1e6 }));
  // Show the current point, the next tier, and room to grow.
  const xMax = Math.max(vN * 0.5, P * 2, ...tiers.map((t) => t.at * 1.15));
  const W = 640, H = 220, L = 8, R = 8, T = 14, B = 26;
  const yMax = priceAt(xMax) * 1.05;
  const X = (x: number) => L + (x / xMax) * (W - L - R);
  const Y = (p: number) => T + (1 - p / yMax) * (H - T - B);

  const path = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const x = (xMax * i) / 80;
      pts.push(`${i ? "L" : "M"}${X(x).toFixed(1)},${Y(priceAt(x)).toFixed(1)}`);
    }
    return pts.join("");
  }, [xMax, vN, vT]);
  const filled = useMemo(() => {
    const n = 40, pts: string[] = [];
    for (let i = 0; i <= n; i++) {
      const x = (P * i) / n;
      pts.push(`L${X(x).toFixed(1)},${Y(priceAt(x)).toFixed(1)}`);
    }
    return `M${X(0)},${Y(0)}${pts.join("")}L${X(P)},${Y(0)}Z`;
  }, [P, xMax, vN, vT]);

  if (!PREVIEW && (!info || !stats)) {
    return <p className="muted pad" role="status">{unavailable ? "Bonding curve unavailable. Retrying…" : "Loading the on-chain bonding curve…"}</p>;
  }

  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(xMax, ((x - L) / (W - L - R)) * xMax)));
  };
  const cursor = hover ?? (scenario === null ? null : scenario * xMax / 100);
  const hx = cursor ?? P;
  const mcap = priceAt(hx) * supplyAt(hx);

  return (
    <div className="curve">
      <div className="curve-head">
        <div>
          <small>{cursor == null ? "Now" : "If the pit held"}</small>
          <b>{fmtN(hx)} Ⓝ</b>
        </div>
        <div><small>Price</small><b>{fmtP(priceAt(hx))} Ⓝ</b></div>
        <div><small>Supply</small><b>{fmtN(supplyAt(hx))}</b></div>
        <div><small>Market cap</small><b>{fmtN(mcap)} Ⓝ</b></div>
        {cursor != null && P > 0 && <div><small>vs now</small><b className={hx >= P ? "up" : "down"}>{hx >= P ? "+" : ""}{((priceAt(hx) / priceAt(P) - 1) * 100).toFixed(1)}%</b></div>}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Bonding curve: price rises from ${fmtP(priceAt(0))} NEAR as NEAR enters the pit; now ${fmtP(priceAt(P))} NEAR at ${near(stats?.principal ?? "0", 0)} NEAR`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <defs>
          <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} className="grid" x1={L} x2={W - R} y1={T + f * (H - T - B)} y2={T + f * (H - T - B)} />)}
        <path d={filled} fill="url(#curve-fill)" />
        <path d={path} className="line" />
        {tiers.filter((t) => t.at > 0 && t.at <= xMax).map((t) => (
          <g key={t.name} className="tier">
            <line x1={X(t.at)} x2={X(t.at)} y1={T} y2={H - B} />
            <text x={X(t.at) + 4} y={T + 10}>{t.name}</text>
          </g>
        ))}
        <circle className="now" cx={X(P)} cy={Y(priceAt(P))} r={5} />
        {cursor != null && (
          <g className="cursor">
            <line x1={X(cursor)} x2={X(cursor)} y1={T} y2={H - B} />
            <circle cx={X(cursor)} cy={Y(priceAt(cursor))} r={4} />
          </g>
        )}
        <text className="axis" x={L} y={H - 8}>0 Ⓝ</text>
        <text className="axis" x={W - R} y={H - 8} textAnchor="end">{fmtN(xMax)} Ⓝ in the pit</text>
      </svg>
      <div className="curve-scenario">
        <label htmlFor={sliderId}>Explore reserve size</label>
        <input id={sliderId} className="range" type="range" min={0} max={100} step={0.1}
          value={scenario ?? P / xMax * 100} aria-valuetext={`${fmtN(hx)} NEAR`}
          onChange={(event) => { setHover(null); setScenario(Number(event.target.value)); }} />
        <button className="btn dark sm" disabled={scenario === null} onClick={() => { setScenario(null); document.getElementById(sliderId)?.focus(); }}>Reset</button>
      </div>
      <p className="muted small">Every buy moves the price up this curve; every sell moves it down. Selling the whole supply returns exactly the NEAR that went in, minus fees — the reserve can't be short.</p>
    </div>
  );
}
