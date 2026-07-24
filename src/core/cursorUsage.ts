import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageWindow } from "../shared/usageLimits";
import { toEpochMs } from "../shared/usageLimits";

/**
 * Reads the Cursor account's current-period plan usage with the SAME credential
 * the Cursor Agent CLI uses (`~/.config/cursor/auth.json`), so the usage meter
 * always describes the account that actually runs Cursor members. The endpoint
 * is Cursor's own dashboard read (`DashboardService/GetCurrentPeriodUsage`);
 * it returns the billing-cycle plan limit/consumption that cursor.com shows.
 * The token never leaves this process except to Cursor's API host.
 */

export const CURSOR_USAGE_ENDPOINT = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export interface CursorUsageResult {
  windows: UsageWindow[];
  /** Set when the read could not produce a meter; shown as a diagnostic. */
  error?: string;
  /** True when the failure is a missing/rejected login (vs a network error). */
  unauthorized?: boolean;
}

/** The CLI's stored OAuth access token, or undefined when not logged in. */
export function readCursorAccessToken(): string | undefined {
  try {
    // Mirrors the CLI's own credential path: `$XDG_CONFIG_HOME || ~/.config`
    // + `cursor/auth.json`, on every platform (the Windows CLI uses it too).
    const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const raw = fs.readFileSync(path.join(configDir, "cursor", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { accessToken?: unknown };
    const token = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCursorUsage(token: string, endpoint: string = CURSOR_USAGE_ENDPOINT): Promise<CursorUsageResult> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { windows: [], error: `Cursor usage request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      windows: [],
      unauthorized: true,
      error: `Cursor usage read was rejected (HTTP ${response.status}). Run \`cursor-agent login\` and retry.`,
    };
  }
  if (!response.ok) {
    return { windows: [], error: `Cursor usage read failed (HTTP ${response.status}).` };
  }
  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    return { windows: [], error: `Cursor usage response was not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const window = cursorUsageWindow(payload);
  if (!window) {
    return { windows: [], error: "Cursor usage read returned no usable plan meter." };
  }
  return { windows: [window] };
}

/**
 * Maps a `GetCurrentPeriodUsage` payload to the shared monthly window. The
 * utilization prefers the server's own percent; otherwise it is derived from
 * used/limit (or limit-remaining). No usable numbers → undefined (never faked).
 */
export function cursorUsageWindow(payload: any): UsageWindow | undefined {
  const plan = payload?.planUsage;
  if (!plan || typeof plan !== "object") {
    return undefined;
  }
  const limit = finitePositive(plan.limit);
  const remaining = finiteNumber(plan.remaining);
  const used = finiteNumber(plan.used);
  let utilization = finiteNumber(plan.totalPercentUsed);
  if (utilization == null && limit != null) {
    const consumed = used != null ? used : remaining != null ? limit - remaining : undefined;
    if (consumed != null) {
      utilization = (consumed / limit) * 100;
    }
  }
  if (utilization == null) {
    return undefined;
  }
  return {
    kind: "monthly",
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt: toEpochMs(finiteNumber(Number(payload?.billingCycleEnd))),
  };
}

function finiteNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function finitePositive(value: unknown): number | undefined {
  const num = finiteNumber(value);
  return num != null && num > 0 ? num : undefined;
}
