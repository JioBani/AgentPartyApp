import type { UsageWindow, UsageWindowKind } from "../shared/usageLimits";

/** Response payload from Grok Build's authenticated `_x.ai/billing` ACP extension. */
export interface GrokBillingResult {
  config?: {
    creditUsagePercent?: unknown;
    currentPeriod?: { type?: unknown; start?: unknown; end?: unknown };
    billingPeriodEnd?: unknown;
  };
  subscription_tier?: unknown;
}

/** Converts Grok's subscription-credit period into the provider-neutral meter. */
export function grokUsageWindow(payload: GrokBillingResult): UsageWindow | undefined {
  const config = payload?.config;
  const utilization = finiteNumber(config?.creditUsagePercent);
  if (utilization == null) return undefined;

  const start = dateMs(config?.currentPeriod?.start);
  const end = dateMs(config?.currentPeriod?.end) ?? dateMs(config?.billingPeriodEnd);
  const kind = grokPeriodKind(config?.currentPeriod?.type, start, end);
  if (!kind) return undefined;

  return { kind, utilization: Math.max(0, Math.min(100, utilization)), resetsAt: end };
}

function grokPeriodKind(raw: unknown, start?: number, end?: number): UsageWindowKind | undefined {
  const type = String(raw || "").toUpperCase();
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (start != null && end != null && end > start) {
    const days = (end - start) / 86_400_000;
    if (days <= 10) return "weekly";
    if (days <= 35) return "monthly";
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
