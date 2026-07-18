import type { MemberView } from "./types";

/** Compact token count: 128000 → "128K", 1000000 → "1M", 940 → "940". */
function formatK(value: number): string {
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  }
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}

interface DonutProps {
  context: NonNullable<MemberView["context"]>;
  autoCompact: MemberView["autoCompact"];
  /** The member's identity color — the donut fill while usage is "safe". */
  color: string;
  /** Show the `used / total` K/K range (wide panels only). */
  showRange: boolean;
  /** Open the Auto-compact dialog for this member. */
  onClick: () => void;
}

/**
 * Context-window occupancy as an 18px donut (ring), not a bar. The ring is a
 * conic-gradient with THREE regions clockwise from 12 o'clock: filled usage →
 * neutral remainder → warm "compaction zone" (threshold → 100%). A tick marks
 * the auto-compact threshold. The whole point of the zone arc is to show how
 * much runway remains before auto-compaction, so it's only drawn when
 * auto-compact is on; off = plain fill + track, no zone, no tick.
 *
 * Fill/readout escalate with occupancy (≥90% danger, ≥75% live, else the member
 * color). An unknown window (`total` missing) degrades to the raw used count and
 * a hollow neutral ring — never a fabricated denominator.
 *
 * Clicking anywhere on the pill opens the Auto-compact dialog — the single entry
 * point for running a compaction and setting the threshold.
 */
export function ContextDonut({ context, autoCompact, color, showRange, onClick }: DonutProps) {
  const { used, total } = context;
  const known = Boolean(total && total > 0);
  const pct = known ? Math.min(100, Math.max(0, Math.round((used / total!) * 100))) : 0;
  const { on, at } = autoCompact;

  const fill = pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--live)" : color;
  const ctxCol = pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--live)" : "var(--text-1)";
  const zone = "var(--compact-zone)";

  // Conic ring: usage fill, the gap to the threshold in the neutral track, then
  // the warm zone from the threshold to full. Once usage passes the threshold
  // the neutral gap disappears and the zone runs straight off the fill.
  let conic: string;
  if (!known) {
    conic = "conic-gradient(var(--bg-4) 0 100%)";
  } else if (!on) {
    conic = `conic-gradient(${fill} 0 ${pct}%, var(--bg-4) ${pct}% 100%)`;
  } else if (pct <= at) {
    conic = `conic-gradient(${fill} 0 ${pct}%, var(--bg-4) ${pct}% ${at}%, ${zone} ${at}% 100%)`;
  } else {
    conic = `conic-gradient(${fill} 0 ${pct}%, ${zone} ${pct}% 100%)`;
  }

  const title = known
    ? `컨텍스트 ${used.toLocaleString()} / ${total!.toLocaleString()} 토큰 (${pct}%)${on ? ` · 자동 압축 ${at}%` : " · 자동 압축 꺼짐"}`
    : `컨텍스트 ${used.toLocaleString()} 토큰 (창 크기 미상)`;

  return (
    <button type="button" className="wb-ctx-donut" title={title} onClick={onClick}>
      <span className="wb-donut-ring" style={{ background: conic }} aria-hidden>
        <span className="wb-donut-hole" />
        {on && known && (
          <span className="wb-donut-tick-wrap" style={{ transform: `rotate(${at * 3.6}deg)` }}>
            <span className="wb-donut-tick" />
          </span>
        )}
      </span>
      {showRange && known && (
        <span className="wb-mono wb-donut-range">{formatK(used)} / {formatK(total!)}</span>
      )}
      <span className="wb-mono wb-donut-pct" style={{ color: ctxCol }}>
        {known ? `${pct}%` : formatK(used)}
      </span>
    </button>
  );
}
