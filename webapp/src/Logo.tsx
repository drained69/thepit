import { useId } from "react";

/**
 * The Pit mascot: a bottomless pit with a goofy brain climbing out of it.
 * Meme energy in the art; the rest of the UI stays clean.
 */
export function PitLogo({ size = 40, hungry = false }: { size?: number; hungry?: boolean }) {
  const id = useId();
  const hole = `pit-hole-${id}`;
  const rim = `pit-rim-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="The Pit">
      <defs>
        <radialGradient id={hole} cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#000" />
          <stop offset="1" stopColor="#1b1030" />
        </radialGradient>
        <linearGradient id={rim} x1="0" x2="1">
          <stop offset="0" stopColor="#c084fc" />
          <stop offset="1" stopColor="#f7a35c" />
        </linearGradient>
      </defs>
      {/* the pit */}
      <ellipse cx="32" cy="46" rx="27" ry="12" fill={`url(#${hole})`} stroke={`url(#${rim})`} strokeWidth="3" />
      {/* brain peeking out */}
      <path
        d="M14 40c-3-9 3-18 11-18 2-5 10-7 14-2 7-2 13 4 11 11 4 3 3 8 0 9H14z"
        fill="#ff9ec4"
        stroke="#d9467a"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M24 27c2 3 0 6 3 8M33 23c-1 4 2 6 0 10M42 27c-2 3 1 6-2 9" fill="none" stroke="#d9467a" strokeWidth="1.8" strokeLinecap="round" />
      {/* googly eyes, one looking the wrong way */}
      <circle cx="25" cy="36" r="5.2" fill="#fff" stroke="#1b1030" strokeWidth="1.4" />
      <circle cx="39" cy="35" r="6.2" fill="#fff" stroke="#1b1030" strokeWidth="1.4" />
      <circle cx="26.6" cy="37.4" r="2.3" fill="#111" />
      <circle cx="37.2" cy="33.6" r="2.8" fill="#111" />
      {/* the drool */}
      {!hungry && <path d="M33 41c0 3 2 6 2 8a2 2 0 0 1-4 0c0-2 2-5 2-8z" fill="#f7a35c" opacity=".9" />}
      {/* rim on top so the brain sits inside */}
      <path d="M5 46a27 12 0 0 0 54 0" fill="none" stroke={`url(#${rim})`} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** The same art as a data URL, for the favicon. */
export const PIT_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><ellipse cx="32" cy="46" rx="27" ry="12" fill="#0b0716" stroke="#c084fc" stroke-width="3"/><path d="M14 40c-3-9 3-18 11-18 2-5 10-7 14-2 7-2 13 4 11 11 4 3 3 8 0 9H14z" fill="#ff9ec4" stroke="#d9467a" stroke-width="2.2"/><circle cx="25" cy="36" r="5.2" fill="#fff"/><circle cx="39" cy="35" r="6.2" fill="#fff"/><circle cx="26.6" cy="37.4" r="2.3" fill="#111"/><circle cx="37.2" cy="33.6" r="2.8" fill="#111"/><path d="M5 46a27 12 0 0 0 54 0" fill="none" stroke="#f7a35c" stroke-width="3"/></svg>`,
  );
