import {
  TOKEN_TRIGGERS,
  type TokenTrigger,
  type TokenUsageQuery,
  type TokenUsageTurnsQuery,
} from "../../shared/tokenUsage";
import { optText, text, type MethodParams } from "./methodRegistry";

/** Named time ranges the dashboard offers, resolved to a [fromMs, toMs) range. */
const TOKEN_USAGE_RANGE_MS: Record<string, number> = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "5h": 5 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  today: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

function timeRangeFrom(params: MethodParams): { fromMs: number; toMs: number } {
  const now = Date.now();
  const fromParam = Number(params.from);
  const toParam = Number(params.to);
  const rangeMs = TOKEN_USAGE_RANGE_MS[text(params.range, "5h")] ?? TOKEN_USAGE_RANGE_MS["5h"];
  const toMs = Number.isFinite(toParam) && toParam > 0 ? toParam : now;
  const fromMs = Number.isFinite(fromParam) && fromParam > 0 ? fromParam : toMs - rangeMs;
  return { fromMs, toMs };
}

/**
 * Builds a {@link TokenUsageQuery} from the token-usage call's parameters.
 * The range preset param is `range`; `window` is reserved for selecting the
 * target app window.
 */
export function tokenUsageQueryFrom(params: MethodParams): TokenUsageQuery {
  const { fromMs, toMs } = timeRangeFrom(params);
  const bucketMinutes = Math.max(1, Number(params.bucket) || 5);
  const triggerParam = optText(params.trigger);
  const trigger = triggerParam && (TOKEN_TRIGGERS as string[]).includes(triggerParam)
    ? (triggerParam as TokenTrigger)
    : undefined;
  return {
    fromMs,
    toMs,
    bucketMinutes,
    partyId: optText(params.party),
    trigger,
  };
}

/** Builds the raw per-turn drill-in query using the same time-range contract. */
export function tokenUsageTurnsQueryFrom(params: MethodParams): TokenUsageTurnsQuery {
  const { fromMs, toMs } = timeRangeFrom(params);
  const limit = Number(params.limit);
  return {
    fromMs,
    toMs,
    partyId: optText(params.party),
    member: optText(params.member),
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  };
}
