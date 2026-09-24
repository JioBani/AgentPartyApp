import type { UsageWindow } from "../shared/usageLimits";

export interface MuseSubscriptionUsage {
  observedAtMs?: number;
  tier?: string;
  window?: {
    usedPercent?: number;
    resetsAtMs?: number;
    windowDurationMins?: number;
  };
  weekly?: {
    usedPercent?: number;
    resetsAtMs?: number;
  };
}

/** Maps Muse MSP's provider-authored subscription snapshot to the shared meter. */
export function museUsageWindows(payload: unknown): UsageWindow[] {
  if (!payload || typeof payload !== "object") return [];
  const usage = payload as MuseSubscriptionUsage;
  const windows: UsageWindow[] = [];
  const current = usage.window;
  if (validPercent(current?.usedPercent) && validReset(current?.resetsAtMs)) {
    windows.push({ kind: "five_hour", utilization: current.usedPercent, resetsAt: current.resetsAtMs });
  }
  const weekly = usage.weekly;
  if (validPercent(weekly?.usedPercent) && validReset(weekly?.resetsAtMs)) {
    windows.push({ kind: "weekly", utilization: weekly.usedPercent, resetsAt: weekly.resetsAtMs });
  }
  return windows;
}

function validPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validReset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
