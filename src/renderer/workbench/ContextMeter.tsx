import type { MemberView } from "./types";

/** Compact token count: 63054 → "63K", 1050000 → "1.05M", 940 → "940". */
function formatTokens(value: number): string {
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  }
  if (value >= 1e3) {
    return `${Math.round(value / 1e3)}K`;
  }
  return String(value);
}

/**
 * Context-window capacity indicator for a member's toolbar. Shows how full the
 * live conversation is against the model's window: a thin fill bar plus
 * `used / total`. When the window is unknown (catalog has no size and the
 * harness didn't report one) it degrades to the raw used count with no bar and
 * no ratio — surfacing the real state rather than inventing a denominator.
 */
export function ContextMeter({ context }: { context: NonNullable<MemberView["context"]> }) {
  const { used, total } = context;
  if (!total) {
    return (
      <span className="wb-ctx-meter is-unbounded" title={`컨텍스트 사용량 ${used.toLocaleString()} 토큰 (전체 창 크기 미상)`}>
        <span className="wb-ctx-text wb-mono">{formatTokens(used)}</span>
      </span>
    );
  }
  const ratio = Math.min(1, used / total);
  const pct = Math.round(ratio * 100);
  const level = ratio >= 0.9 ? "is-critical" : ratio >= 0.7 ? "is-warn" : "is-ok";
  return (
    <span
      className={"wb-ctx-meter " + level}
      title={`컨텍스트 ${used.toLocaleString()} / ${total.toLocaleString()} 토큰 (${pct}%)`}
    >
      <span className="wb-ctx-bar" aria-hidden>
        <span className="wb-ctx-fill" style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
      <span className="wb-ctx-text wb-mono">
        {formatTokens(used)}<span className="wb-ctx-sep">/</span>{formatTokens(total)}
      </span>
    </span>
  );
}
