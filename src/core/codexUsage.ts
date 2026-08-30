import type { TurnTokenBreakdown } from "../shared/tokenUsage";
import type { TurnUsage } from "./costing";

/** Normalizes one Codex app-server usage frame without inventing missing counters. */
export function normalizeCodexUsage(value: unknown): TurnUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: finite(usage.inputTokens),
    cachedInputTokens: finite(usage.cachedInputTokens),
    cacheWriteInputTokens: finite(usage.cacheWriteInputTokens),
    outputTokens: finite(usage.outputTokens),
    totalTokens: finite(usage.totalTokens),
  };
}

/** Adds a Codex `last` frame to the current turn's internal-request total. */
export function addCodexUsage(current: TurnUsage | undefined, next: TurnUsage): TurnUsage {
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a == null && b == null ? undefined : (a || 0) + (b || 0);
  const priorRequests = current?.requestUsages
    ?? (current ? [withoutRequestUsages(current)] : []);
  return {
    inputTokens: add(current?.inputTokens, next.inputTokens),
    cachedInputTokens: add(current?.cachedInputTokens, next.cachedInputTokens),
    cacheWriteInputTokens: add(current?.cacheWriteInputTokens, next.cacheWriteInputTokens),
    outputTokens: add(current?.outputTokens, next.outputTokens),
    totalTokens: add(current?.totalTokens, next.totalTokens),
    requestUsages: [...priorRequests, withoutRequestUsages(next)],
  };
}

function withoutRequestUsages(usage: TurnUsage): TurnUsage {
  const { requestUsages: _ignored, ...request } = usage;
  return request;
}

/**
 * Converts Codex counters to disjoint ledger buckets. Codex `inputTokens`
 * includes cached/cache-write tokens, so those subsets must be removed from
 * fresh input or the dashboard double-counts and charges them at the full rate.
 */
export function codexTokenBreakdown(
  usage: TurnUsage | undefined,
  context: number | undefined,
): TurnTokenBreakdown | undefined {
  const input = usage?.inputTokens;
  const cacheRead = usage?.cachedInputTokens;
  const cacheWrite = usage?.cacheWriteInputTokens;
  const output = usage?.outputTokens;
  if (input == null && output == null && context == null) return undefined;
  const breakdown = (part: TurnUsage) => ({
    input: part.inputTokens == null ? undefined : Math.max(0, part.inputTokens - (part.cachedInputTokens || 0) - (part.cacheWriteInputTokens || 0)),
    cacheRead: part.cachedInputTokens,
    cacheWrite: part.cacheWriteInputTokens,
    output: part.outputTokens,
  });
  return {
    input: input == null ? undefined : Math.max(0, input - (cacheRead || 0) - (cacheWrite || 0)),
    cacheRead,
    cacheWrite,
    output,
    context,
    pricingSegments: usage?.requestUsages?.map(breakdown),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
