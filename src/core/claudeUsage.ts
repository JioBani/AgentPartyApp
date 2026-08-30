import type { TurnTokenBreakdown } from "../shared/tokenUsage";

/** Converts Claude SDK usage into disjoint ledger buckets, preserving cache TTLs. */
export function tokenBreakdownFromClaudeUsage(usage: unknown): TurnTokenBreakdown | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  const input = finite(record.input_tokens);
  const cacheRead = finite(record.cache_read_input_tokens);
  const cacheWrite = finite(record.cache_creation_input_tokens);
  const cacheCreation = asRecord(record.cache_creation);
  const cacheWrite5m = finite(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheWrite1h = finite(cacheCreation?.ephemeral_1h_input_tokens);
  const output = finite(record.output_tokens);
  if (input == null && cacheRead == null && cacheWrite == null && output == null) return undefined;
  return { input, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, output };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
