/**
 * Provider usage-limit model + pure view logic for the titlebar usage indicator.
 *
 * These are ACCOUNT/provider-scoped rate limits (shared by every agent using that
 * provider), NOT per-session context occupancy — see `ContextMeter` for the
 * latter. The real data arrives through each harness's own event stream
 * (Claude's `rate_limit_event`, Codex's `account/rateLimits/updated`); the main
 * process merges those into one {@link UsageLimitsSnapshot} per provider and
 * pushes it to every window.
 *
 * Everything here is pure (no DOM, no Electron) so the renderer and the QA/jsdom
 * suites build the identical view from the same code.
 */

export type UsageProviderId = "claude" | "codex" | "cursor";

/**
 * The rolling windows the indicator can show. Claude/Codex report 5-hour +
 * weekly account windows; Cursor reports one billing-cycle plan meter
 * (`monthly`). See {@link PROVIDER_WINDOW_KINDS} for which provider shows what.
 */
export type UsageWindowKind = "five_hour" | "weekly" | "monthly";

export interface UsageWindow {
  kind: UsageWindowKind;
  /** Percent of the window consumed, 0–100 (provider-reported). */
  utilization: number;
  /** When the window resets, epoch ms. Absent when the provider didn't report it. */
  resetsAt?: number;
}

export interface ProviderUsage {
  provider: UsageProviderId;
  /**
   * `false` when the provider reported that limits are not applicable (Claude API
   * key / Bedrock / Vertex — `rate_limits_available:false`). Undefined = unknown
   * (no report yet). Drives an explicit "해당 없음/불러오는 중" state instead of a
   * fabricated 0%.
   */
  available?: boolean;
  windows: UsageWindow[];
  /** Epoch ms of the last update, for staleness / debugging. */
  updatedAt: number;
}

export type UsageLimitsSnapshot = {
  claude?: ProviderUsage;
  codex?: ProviderUsage;
  cursor?: ProviderUsage;
};

/** Provider display metadata. Brand colors are design literals, not theme tokens. */
export const USAGE_PROVIDERS: Record<UsageProviderId, { label: string; brand: string }> = {
  claude: { label: "Claude", brand: "#c5835f" },
  codex: { label: "Codex", brand: "#2bb67e" },
  cursor: { label: "Cursor", brand: "#8e92a3" },
};

/** Fixed display order (matches the design). */
export const USAGE_PROVIDER_ORDER: UsageProviderId[] = ["claude", "codex", "cursor"];

/**
 * The windows each provider actually has. Rendering the union for everyone
 * would show permanent "데이터 없음" rows (e.g. a 5-hour meter Cursor never
 * reports), so the view builds only the provider's own kinds.
 */
export const PROVIDER_WINDOW_KINDS: Record<UsageProviderId, UsageWindowKind[]> = {
  claude: ["five_hour", "weekly"],
  codex: ["five_hour", "weekly"],
  cursor: ["monthly"],
};

/** The usage provider a party member's runtime draws its account quota from. */
export function providerOfRuntime(runtime: string | undefined): UsageProviderId | undefined {
  if (runtime === "codex") {
    return "codex";
  }
  if (runtime === "cursor") {
    return "cursor";
  }
  if (runtime === "claude-code" || runtime === "claude") {
    return "claude";
  }
  return undefined;
}

/** The usage provider a harness id belongs to (codex/cursor vs the Claude family). */
export function providerOfHarness(harnessId: string | undefined): UsageProviderId | undefined {
  if (harnessId === "codex") return "codex";
  if (harnessId === "cursor") return "cursor";
  if (harnessId === "claude-code" || harnessId === "claude") return "claude";
  return undefined;
}

/**
 * Pure decision for the background usage poller: given which providers we WANT
 * kept fresh (they have members), which already have a live session (self-poll),
 * which background adapters are already running, and any per-provider retry
 * backoff, returns the providers to start and to dispose. A provider is polled in
 * the background only when it is wanted AND has no live session — so an open
 * member session is reused rather than duplicated, and an unused provider spawns
 * nothing. Kept pure (no processes) so the reconciliation is unit-testable.
 */
export function reconcileUsageTargets(input: {
  desired: UsageProviderId[];
  liveProviders: UsageProviderId[];
  running: UsageProviderId[];
  backoffUntil?: Partial<Record<UsageProviderId, number>>;
  now: number;
}): { start: UsageProviderId[]; dispose: UsageProviderId[] } {
  const desired = new Set(input.desired);
  const live = new Set(input.liveProviders);
  const running = new Set(input.running);
  const start: UsageProviderId[] = [];
  const dispose: UsageProviderId[] = [];
  for (const provider of USAGE_PROVIDER_ORDER) {
    const wanted = desired.has(provider) && !live.has(provider);
    if (wanted && !running.has(provider)) {
      if (input.now >= (input.backoffUntil?.[provider] || 0)) {
        start.push(provider);
      }
    } else if (!wanted && running.has(provider)) {
      dispose.push(provider);
    }
  }
  return { start, dispose };
}
const WINDOW_ORDER: UsageWindowKind[] = ["five_hour", "weekly", "monthly"];
const WINDOW_LABELS: Record<UsageWindowKind, string> = { five_hour: "5시간 한도", weekly: "주간 한도", monthly: "플랜 한도 (결제 주기)" };

/**
 * Normalizes a provider-reported reset timestamp to epoch **ms**. Providers vary:
 * Codex reports epoch seconds, Claude epoch (seconds or ms). Values below 1e12 are
 * treated as seconds. Non-positive / non-finite → undefined (never a fake reset).
 */
export function toEpochMs(value: number | undefined | null): number | undefined {
  if (typeof value !== "number" || !isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/** Level escalation color as a CSS value. Unknown pct → muted text color. */
export function usageLevelColor(pct: number | undefined, brand: string): string {
  if (pct == null || !isFinite(pct)) {
    return "var(--text-3)";
  }
  if (pct >= 90) {
    return "var(--danger)";
  }
  if (pct >= 75) {
    return "var(--live)";
  }
  return brand;
}

/**
 * Human reset countdown, e.g. "2시간 12분" or "4일 6시간" — the top two non-zero
 * units among day/hour/minute. Absent reset → undefined; already elapsed → "곧".
 */
export function formatResetCountdown(resetsAt: number | undefined, nowMs: number): string | undefined {
  if (!resetsAt) {
    return undefined;
  }
  let secs = Math.round((resetsAt - nowMs) / 1000);
  if (secs <= 0) {
    return "곧";
  }
  const days = Math.floor(secs / 86400);
  secs -= days * 86400;
  const hours = Math.floor(secs / 3600);
  secs -= hours * 3600;
  const minutes = Math.floor(secs / 60);
  const units: Array<[number, string]> = [
    [days, "일"],
    [hours, "시간"],
    [minutes, "분"],
  ];
  const shown = units.filter(([v]) => v > 0).slice(0, 2).map(([v, u]) => `${v}${u}`);
  return shown.length ? shown.join(" ") : "1분";
}

/** Merges incoming windows onto prior ones by kind (latest per kind wins). */
export function mergeWindows(prev: UsageWindow[] | undefined, incoming: UsageWindow[]): UsageWindow[] {
  const byKind = new Map<UsageWindowKind, UsageWindow>();
  for (const w of prev || []) {
    byKind.set(w.kind, w);
  }
  for (const w of incoming) {
    byKind.set(w.kind, w);
  }
  return WINDOW_ORDER.map((k) => byKind.get(k)).filter((w): w is UsageWindow => Boolean(w));
}

/**
 * Folds a provider's freshly-reported windows into the prior snapshot. A report
 * usually carries only the window that changed (Claude sends one `rateLimitType`
 * per event), so unreported windows are preserved rather than dropped.
 */
export function mergeProviderUsage(
  prev: ProviderUsage | undefined,
  incoming: { provider: UsageProviderId; windows: UsageWindow[]; available?: boolean; updatedAt: number },
): ProviderUsage {
  const windows = mergeWindows(prev?.windows, incoming.windows);
  return {
    provider: incoming.provider,
    // Reported windows are ground truth that limits ARE observable. Claude's
    // proactive usage read can answer "not available for this auth mode" on the
    // very account whose live rate_limit_events feed real meters; letting that
    // read stamp available:false hid a real 30%/14% reading behind "N/A".
    available: windows.length > 0 ? true : incoming.available ?? prev?.available,
    windows,
    updatedAt: incoming.updatedAt,
  };
}

// --- View model (consumed by the renderer + QA) ----------------------------

export interface UsagePillSegment {
  key: UsageProviderId;
  label: string;
  /** "63%" or "—" when the 5-hour window is unknown. */
  pctLabel: string;
  /** conic-gradient donut background. */
  ring: string;
  holeBg: string;
  labelCol: string;
  pctCol: string;
}

export interface UsageMeterView {
  kind: UsageWindowKind;
  name: string;
  /** CSS width, e.g. "63%" (0% when unknown). */
  pctWidth: string;
  col: string;
  /** Right-hand label, e.g. "63% · 2시간 12분 후 리셋" or "데이터 없음". */
  right: string;
  known: boolean;
}

export interface UsageRowView {
  key: UsageProviderId;
  label: string;
  brand: string;
  /** e.g. "3명 사용". */
  sub: string;
  meters: UsageMeterView[];
}

export interface UsageView {
  pills: UsagePillSegment[];
  rows: UsageRowView[];
  /** Any provider's 5h OR weekly usage ≥ 75 — drives the pill's warning border. */
  anyHigh: boolean;
  /** True when no provider has any usage data yet (loading/empty). */
  empty: boolean;
}

function windowOf(usage: ProviderUsage | undefined, kind: UsageWindowKind): UsageWindow | undefined {
  return usage?.windows.find((w) => w.kind === kind);
}

/**
 * Builds the full pill + popover view. Claude and Codex are always shown so the
 * user can see whether a provider is still loading, unavailable, or reporting
 * data even before a member exists. `membersByProvider` counts party members
 * driving each provider.
 */
export function buildUsageView(
  snapshot: UsageLimitsSnapshot,
  membersByProvider: Partial<Record<UsageProviderId, number>>,
  nowMs: number,
): UsageView {
  const pills: UsagePillSegment[] = [];
  const rows: UsageRowView[] = [];
  let anyHigh = false;
  let anyData = false;

  for (const provider of USAGE_PROVIDER_ORDER) {
    const usage = snapshot[provider];
    const members = membersByProvider[provider] || 0;
    const { label, brand } = USAGE_PROVIDERS[provider];
    const kinds = PROVIDER_WINDOW_KINDS[provider];
    const notApplicable = usage?.available === false;

    const providerWindows = kinds
      .map((kind) => windowOf(usage, kind))
      .filter((w): w is UsageWindow => Boolean(w));
    if (providerWindows.length) {
      anyData = true;
    }
    if (providerWindows.some((w) => w.utilization >= 75)) {
      anyHigh = true;
    }

    // The pill donut shows the provider's PRIMARY window — the first of its
    // kinds that has data (5-hour for Claude/Codex, the plan meter for
    // Cursor). Falling back to later kinds matters: a provider reporting only
    // its weekly window (e.g. an exhausted account) must not render "—".
    const primary = notApplicable ? undefined : providerWindows[0];
    const primaryPct = primary?.utilization;
    const primaryCol = usageLevelColor(primaryPct, brand);
    pills.push({
      key: provider,
      label,
      pctLabel: notApplicable ? "N/A" : primaryPct == null ? "—" : `${Math.round(primaryPct)}%`,
      ring:
        primaryPct == null
          ? "var(--bg-4)"
          : `conic-gradient(${primaryCol} 0 ${primaryPct}%, var(--bg-4) ${primaryPct}% 100%)`,
      holeBg: "var(--bg-2)",
      labelCol: "var(--text-1)",
      pctCol: primaryPct == null ? "var(--text-3)" : primaryCol,
    });

    const meters: UsageMeterView[] = kinds.map((kind) => {
      const w = notApplicable ? undefined : windowOf(usage, kind);
      if (!w) {
        return {
          kind,
          name: WINDOW_LABELS[kind],
          pctWidth: "0%",
          col: "var(--text-3)",
          right: notApplicable ? "해당 없음 (API 키)" : usage ? "데이터 없음" : "불러오는 중…",
          known: false,
        };
      }
      const pct = Math.round(w.utilization);
      const countdown = formatResetCountdown(w.resetsAt, nowMs);
      return {
        kind,
        name: WINDOW_LABELS[kind],
        pctWidth: `${w.utilization}%`,
        col: usageLevelColor(w.utilization, brand),
        right: countdown ? `${pct}% · ${countdown} 후 리셋` : `${pct}%`,
        known: true,
      };
    });

    rows.push({ key: provider, label, brand, sub: `${members}명 사용`, meters });
  }

  return { pills, rows, anyHigh, empty: !anyData };
}
