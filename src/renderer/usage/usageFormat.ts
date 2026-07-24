/**
 * Pure formatting + shaping helpers for the Token Usage dashboard.
 *
 * Kept free of React/DOM so the number rules (tabular mono, `k`/`M` abbreviation,
 * honest "아직 없음" for absent values) live in one testable place — the design
 * brief §9 makes number legibility a first-class requirement.
 */

import type { TokenTrigger } from "../../shared/tokenUsage";

/** Token count → `1.2M` / `12.4k` / `842`. Consistent across a whole column. */
export function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

/** Coarser token abbreviation for chart axis ticks (`1.2M` / `120k` / `0k`). */
export function fmtTokensAxis(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  return Math.round(n / 1_000) + "k";
}

/** Rate (tokens/hour) → `214k/h` / `1.2M/h`. Absent → "—". */
export function fmtRate(perHour: number | undefined): string {
  if (perHour === undefined || !Number.isFinite(perHour)) return "—";
  if (perHour >= 1_000_000) return (perHour / 1_000_000).toFixed(1) + "M/h";
  return Math.round(perHour / 1_000) + "k/h";
}

/** Milliseconds of active time → `4시간 36분` / `52분` / `아직 없음` for 0. */
export function fmtActive(ms: number): string {
  if (!ms || ms <= 0) return "아직 없음";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}분`;
  return `${h}시간 ${String(m).padStart(2, "0")}분`;
}

/** Ratio 0–1 → integer percent string, or "—" when the ratio is absent. */
export function fmtPct(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  return Math.round(ratio * 100) + "%";
}

/** Estimated window-share, always prefixed `~` and marked as an estimate. */
export function fmtEstPct(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  const pct = ratio * 100;
  return "~" + (pct < 1 ? pct.toFixed(2) : pct.toFixed(1)) + "%";
}

/** Signed delta percent → `+18%` / `-52%` / "—" when undefined. */
export function fmtDelta(pct: number | undefined): string {
  if (pct === undefined || !Number.isFinite(pct)) return "—";
  return (pct >= 0 ? "+" : "") + Math.round(pct) + "%";
}

/** A trend's arrow + semantic color (rising spend = danger, falling = success). */
export function trendMark(pct: number | undefined): { arrow: string; color: string } {
  if (pct === undefined || !Number.isFinite(pct)) return { arrow: "–", color: "var(--text-3)" };
  if (pct > 5) return { arrow: "▲", color: "var(--danger)" };
  if (pct < -5) return { arrow: "▼", color: "var(--success)" };
  return { arrow: "–", color: "var(--text-3)" };
}

/** Range presets → an inclusive window (ms) ending now. */
export interface RangePreset {
  key: string;
  label: string;
  rangeMs: number;
  /** Default bucket width (minutes) that fits the preset without over-crowding. */
  bucketMinutes: number;
}

export const RANGE_PRESETS: RangePreset[] = [
  { key: "5h", label: "현재 5시간 한도", rangeMs: 5 * 3_600_000, bucketMinutes: 5 },
  { key: "weekly", label: "현재 주간 한도", rangeMs: 7 * 24 * 3_600_000, bucketMinutes: 240 },
  { key: "today", label: "오늘", rangeMs: 24 * 3_600_000, bucketMinutes: 30 },
  { key: "24h", label: "어제", rangeMs: 24 * 3_600_000, bucketMinutes: 30 },
  { key: "1h", label: "기간 지정", rangeMs: 3_600_000, bucketMinutes: 1 },
];

/** Bucket-interval presets (design G1 controls). */
export const INTERVAL_PRESETS: Array<{ key: string; label: string; minutes: number; n: number }> = [
  // `n` = how many bars the interval shows; span = minutes×n ending now, so a
  // finer interval zooms into a shorter, more detailed window (stock-candle feel).
  { key: "1m", label: "1분", minutes: 1, n: 90 },
  { key: "3m", label: "3분", minutes: 3, n: 80 },
  { key: "5m", label: "5분", minutes: 5, n: 72 },
  { key: "15m", label: "15분", minutes: 15, n: 64 },
  { key: "30m", label: "30분", minutes: 30, n: 56 },
  { key: "1h", label: "1시간", minutes: 60, n: 48 },
  { key: "4h", label: "4시간", minutes: 240, n: 42 },
  { key: "1d", label: "1일", minutes: 1440, n: 30 },
];

/** Trigger display metadata (label hint + overhead flag + series color). */
export const TRIGGER_META: Record<TokenTrigger, { note: string; overhead: boolean; color: string }> = {
  "user": { note: "사람 지시 · 기준선", overhead: false, color: "#9aa1ac" },
  "party-message": { note: "멤버 간 메시지", overhead: true, color: "var(--accent)" },
  "gate-review": { note: "게이트 리뷰어", overhead: true, color: "var(--live)" },
  "compact": { note: "컨텍스트 압축", overhead: true, color: "#8b83b8" },
  "subagent": { note: "서브에이전트", overhead: false, color: "#3aa8c9" },
  "init": { note: "초기화·폴링 · 고정비", overhead: true, color: "var(--border-strong)" },
  "unknown": { note: "원인 미상", overhead: false, color: "var(--text-3)" },
};

/** Order triggers are shown in Table B / G2 (design order). */
export const TRIGGER_ORDER: TokenTrigger[] = [
  "user", "party-message", "gate-review", "compact", "subagent", "init", "unknown",
];

/** Format a bucket start (epoch ms) as an axis label for the given interval. */
export function fmtBucketLabel(tMs: number, intervalMinutes: number): string {
  const d = new Date(tMs);
  const p = (x: number) => String(x).padStart(2, "0");
  if (intervalMinutes >= 240) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
