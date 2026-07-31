import {
  TOKEN_TRIGGERS,
  type TokenTrigger,
  type TokenUsageQuery,
  type TokenUsageTurnsQuery,
} from "../../shared/tokenUsage";

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

function timeRangeFrom(url: URL): { fromMs: number; toMs: number } {
  const now = Date.now();
  const fromParam = Number(url.searchParams.get("from"));
  const toParam = Number(url.searchParams.get("to"));
  const rangeMs = TOKEN_USAGE_RANGE_MS[url.searchParams.get("range") || "5h"] ?? TOKEN_USAGE_RANGE_MS["5h"];
  const toMs = Number.isFinite(toParam) && toParam > 0 ? toParam : now;
  const fromMs = Number.isFinite(fromParam) && fromParam > 0 ? fromParam : toMs - rangeMs;
  return { fromMs, toMs };
}

/**
 * Builds a {@link TokenUsageQuery} from `GET /api/token-usage` query params.
 * The range preset param is `range`; `window` is reserved for selecting the
 * target app window.
 */
export function tokenUsageQueryFrom(url: URL): TokenUsageQuery {
  const { fromMs, toMs } = timeRangeFrom(url);
  const bucketMinutes = Math.max(1, Number(url.searchParams.get("bucket")) || 5);
  const triggerParam = url.searchParams.get("trigger") || undefined;
  const trigger = triggerParam && (TOKEN_TRIGGERS as string[]).includes(triggerParam)
    ? (triggerParam as TokenTrigger)
    : undefined;
  return {
    fromMs,
    toMs,
    bucketMinutes,
    partyId: url.searchParams.get("party") || undefined,
    trigger,
  };
}

/** Builds the raw per-turn drill-in query using the same time-range contract. */
export function tokenUsageTurnsQueryFrom(url: URL): TokenUsageTurnsQuery {
  const { fromMs, toMs } = timeRangeFrom(url);
  const limit = Number(url.searchParams.get("limit"));
  return {
    fromMs,
    toMs,
    partyId: url.searchParams.get("party") || undefined,
    member: url.searchParams.get("member") || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  };
}

