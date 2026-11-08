/** Small pieces shared by every page. */
import { useState } from "react";
import { EXPLORER } from "../lib/near";
import { isImageIcon, useCoinIcon } from "./icon";
import { PitLogo } from "./Logo";

/** Emoji, on-chain raster image (validated again here), or the Pit mascot. Never a remote URL. */
export function CoinIcon({ icon, size = 46, contract, hasImage }: { icon: string | null; size?: number; contract?: string; hasImage?: boolean }) {
  const shown = useCoinIcon(contract, icon, hasImage);
  const emoji = shown && !shown.startsWith("data:") && !/^[a-z]+:/i.test(shown) ? shown : null;
  return (
    <span className="coin-icon" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {isImageIcon(shown) ? <img src={shown} alt="" width={size} height={size} draggable={false} /> : emoji ?? <PitLogo size={size * 0.8} />}
    </span>
  );
}

export function Ticker({ icon, title, value, note, tone }: { icon: string; title: string; value: string; note: string; tone?: "brain" }) {
  return (
    <div className="ticker">
      <span className="coin" aria-hidden>{icon}</span>
      <div>
        <strong>{title} <em style={tone === "brain" ? { color: "var(--brain)" } : undefined}>{value}</em></strong>
        <small>{note}</small>
      </div>
    </div>
  );
}

/** An account id with copy and explorer buttons. */
export function AccountLink({ id, label }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(id).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }).catch(() => {});
  return (
    <span className="acct">
      {label && <small>{label}</small>}
      <code title={id}>{id}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${id}`}>{copied ? "✓" : "⧉"}</button>
      <a href={`${EXPLORER}/address/${id}`} target="_blank" rel="noreferrer" aria-label={`${id} on the explorer`}>↗</a>
    </span>
  );
}
