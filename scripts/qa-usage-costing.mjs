import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const usage = await import(pathToFileURL(path.join(root, "dist", "shared", "tokenUsage.js")).href);
const codex = await import(pathToFileURL(path.join(root, "dist", "core", "codexUsage.js")).href);
const claude = await import(pathToFileURL(path.join(root, "dist", "core", "claudeUsage.js")).href);
const costing = await import(pathToFileURL(path.join(root, "dist", "core", "costing.js")).href);

const turn = (model, tokens, extra = {}) => ({
  at: new Date().toISOString(), appSessionId: "qa", trigger: "user", model, tokens, ...extra,
});
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${label}: expected ${expected}, got ${actual}`);

console.log("Current OpenAI list prices:");
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-sol", { input: 100_000, output: 100_000 })), 2.4, "Sol $4/$20");
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-terra", { input: 100_000, output: 100_000 })), 1.4, "Terra $2/$12");
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-luna", { input: 100_000, output: 100_000 })), 0.14, "Luna $0.20/$1.20");
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-luna", { cacheRead: 100_000, cacheWrite: 100_000 })), 0.027, "OpenAI cached read/write rates");
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-sol", { input: 100_000, output: 100_000 }, { serviceTier: "priority" })), 4.8, "Sol Fast/Priority");
close(usage.estimatedTurnCostUsd(turn("gpt-5.5", { input: 100_000, output: 100_000 }, { serviceTier: "fast" })), 8.75, "GPT-5.5 Fast");

console.log("OpenAI long-context pricing per model request:");
const segmentedLongContext = {
  input: 300_000,
  output: 100_000,
  pricingSegments: [
    { input: 200_000, output: 50_000 },
    { input: 100_000, output: 50_000 },
  ],
};
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-sol", segmentedLongContext)), 3.2, "two requests below threshold");
close(usage.estimatedTurnCostUsd(turn("gpt-5.6-sol", {
  input: 300_000, output: 100_000, pricingSegments: [{ input: 300_000, output: 100_000 }],
})), 5.4, "one request above threshold");

console.log("Claude cache TTL pricing:");
const claudeTokens = claude.tokenBreakdownFromClaudeUsage({
  input_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 2_000_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  output_tokens: 1_000_000,
});
assert.deepEqual(claudeTokens, {
  input: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 2_000_000,
  cacheWrite5m: 1_000_000,
  cacheWrite1h: 1_000_000,
  output: 1_000_000,
});
close(usage.estimatedTurnCostUsd(turn("claude-sonnet-4-6", claudeTokens)), 28.05, "Sonnet fresh/read/5m-write/1h-write/output");
const claudeReported = await new costing.DefaultTurnCostResolver().resolve({
  providerId: "anthropic",
  model: "claude-sonnet-4-6",
  runtimeModel: "claude-sonnet-4-6",
  pricing: { billing: "subscription", directPrice: "Claude subscription" },
  harnessCostUsd: 0.42,
});
assert.equal(claudeReported.amountUsd, 0.42);
assert.equal(claudeReported.basis, "harness-reported");

console.log("Codex multi-request and cache normalization:");
const first = codex.normalizeCodexUsage({ totalTokens: 14725, inputTokens: 14511, cachedInputTokens: 14208, cacheWriteInputTokens: 0, outputTokens: 214 });
const second = codex.normalizeCodexUsage({ totalTokens: 14767, inputTokens: 14753, cachedInputTokens: 14208, cacheWriteInputTokens: 0, outputTokens: 14 });
const combined = codex.addCodexUsage(first, second);
assert.deepEqual(codex.codexTokenBreakdown(combined, 14767), {
  input: 848, cacheRead: 28416, cacheWrite: 0, output: 228, context: 14767,
  pricingSegments: [
    { input: 303, cacheRead: 14208, cacheWrite: 0, output: 214 },
    { input: 545, cacheRead: 14208, cacheWrite: 0, output: 14 },
  ],
});

console.log("Cursor Standard/Fast pricing:");
const cursorTokens = { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
close(usage.estimatedTurnCostUsd(turn("Grok 4.5", cursorTokens, { provider: "cursor", serviceTier: "standard" })), 8.5, "Cursor standard");
close(usage.estimatedTurnCostUsd(turn("Grok 4.5", cursorTokens, { provider: "cursor", serviceTier: "fast" })), 23, "Cursor fast");
close(usage.estimatedTurnCostUsd(turn("Grok 4.5", cursorTokens, { provider: "cursor" })), 8.5, "historical Cursor default tier");

console.log("Grok exact provider cost precedence:");
const exact = turn("grok-4.6", { input: 13433, cacheRead: 5376, output: 29 }, { provider: "grok", costUsd: 0.0286528, costBasis: "provider-reported" });
close(usage.effectiveTurnCostUsd(exact), 0.0286528, "xAI cost ticks");
const aggregate = usage.aggregateUsage([exact], { fromMs: Date.now() - 60_000, toMs: Date.now() + 60_000, bucketMinutes: 5 });
close(aggregate.totals.effectiveCostUsd, 0.0286528, "aggregate exact cost");
assert.equal(aggregate.totals.reportedCostTurns, 1);
assert.equal(aggregate.totals.estimatedCostTurns, 0);
assert.equal(aggregate.totals.unpricedTurns, 0);

console.log("USAGE COSTING QA PASSED");
