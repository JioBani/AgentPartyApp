/**
 * A recording window: "start", "stop", and hard budgets given at the start.
 *
 * A single snapshot answers "what is it holding now". It cannot answer "what
 * GREW", which is the actual question behind a slow app — and the growth
 * happens while the user is working, not while anyone is watching. So the
 * report can be put on a timer, but only inside an explicitly opened window
 * with a stated end: an always-on sampler would be exactly the background cost
 * this whole surface is supposed to avoid.
 *
 * Everything is bounded before it starts:
 *  - samples live in memory, capped by count, and cost ~1KB each (numbers);
 *  - the recording stops itself at the sample or minute budget, whichever comes
 *    first, and says WHY it stopped;
 *  - nothing touches the disk unless the caller asked for a file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../logger";
import { getUserDataDir } from "../userDataDir";
import { collectPerfSnapshot, round, type PerfInspectorDeps, type PerfSnapshot } from "./perfInspector";

export interface RecordingBudget {
  intervalMs: number;
  maxSamples: number;
  maxMinutes: number;
  includeHarness: boolean;
  toDisk: boolean;
}

export type RecordingStopReason = "manual" | "budget" | "shutdown" | "error";

export interface RecordingStatus {
  recording: boolean;
  id?: string;
  startedAt?: string;
  /** What the budget ACTUALLY is, after clamping — never what was asked for. */
  applied?: RecordingBudget;
  samples: number;
  remainingSamples?: number;
  remainingMinutes?: number;
  filePath?: string;
  stoppedAt?: string;
  stoppedReason?: RecordingStopReason;
  approxMemoryKb?: number;
}

/**
 * Ceilings the caller cannot raise. The point of taking parameters is control
 * over the trade-off, not permission to make the app worse: a one-second
 * interval for six hours is 21,600 samples, so the count cap is what really
 * bounds memory and the minute cap bounds how long a forgotten recording runs.
 */
const LIMITS = {
  minIntervalMs: 1_000,
  maxIntervalMs: 300_000,
  maxSamples: 5_000,
  maxMinutes: 360,
} as const;

const DEFAULTS: RecordingBudget = {
  intervalMs: 5_000,
  maxSamples: 720,
  maxMinutes: 60,
  includeHarness: false,
  toDisk: false,
};

interface ActiveRecording {
  id: string;
  startedAt: number;
  budget: RecordingBudget;
  samples: PerfSnapshot[];
  timer: NodeJS.Timeout;
  filePath?: string;
  collecting: boolean;
}

let active: ActiveRecording | null = null;
let last: { id: string; startedAt: number; stoppedAt: number; reason: RecordingStopReason; samples: number } | null = null;

export function recordingStatus(): RecordingStatus {
  if (!active) {
    return last
      ? {
        recording: false,
        id: last.id,
        startedAt: new Date(last.startedAt).toISOString(),
        samples: last.samples,
        stoppedAt: new Date(last.stoppedAt).toISOString(),
        stoppedReason: last.reason,
      }
      : { recording: false, samples: 0 };
  }
  const elapsedMinutes = (Date.now() - active.startedAt) / 60_000;
  return {
    recording: true,
    id: active.id,
    startedAt: new Date(active.startedAt).toISOString(),
    applied: active.budget,
    samples: active.samples.length,
    remainingSamples: Math.max(0, active.budget.maxSamples - active.samples.length),
    remainingMinutes: round(Math.max(0, active.budget.maxMinutes - elapsedMinutes), 1),
    filePath: active.filePath,
    approxMemoryKb: round((active.samples.length * approximateSampleKb()), 0),
  };
}

/**
 * Opens a recording window. Refuses while one is running rather than replacing
 * it: the running one is someone's evidence, and silently restarting would
 * throw away the interval they were trying to catch.
 */
export async function startRecording(
  deps: PerfInspectorDeps,
  request: Partial<RecordingBudget> = {},
): Promise<{ ok: true; id: string; applied: RecordingBudget; filePath?: string; clamped: string[] }> {
  if (active) {
    throw new Error(`이미 기록 중입니다 (id: ${active.id}, 샘플 ${active.samples.length}개). 먼저 중지하세요.`);
  }
  const clamped: string[] = [];
  const budget = clampBudget(request, clamped);
  const id = `perf-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const filePath = budget.toDisk ? path.join(perfDir(), `${id}.ndjson`) : undefined;
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  active = {
    id,
    startedAt: Date.now(),
    budget,
    samples: [],
    filePath,
    collecting: false,
    timer: setInterval(() => void tick(deps), budget.intervalMs),
  };
  log("info", "perf", "recording started", { id, budget });
  // A first sample immediately, so a short recording still has a baseline to
  // compare against rather than starting at its own first tick.
  await tick(deps);
  return { ok: true, id, applied: budget, filePath, clamped };
}

export interface RecordingResult {
  ok: true;
  id: string;
  startedAt: string;
  stoppedAt: string;
  stoppedReason: RecordingStopReason;
  applied: RecordingBudget;
  sampleCount: number;
  filePath?: string;
  /** What changed in SIZE over the window — the reason to record in the first place. */
  growth: GrowthRow[];
  /**
   * What HAPPENED over the window: long tasks, CPU, event-loop lag, and how
   * much traffic crossed. A slow app is often not a big one, and none of that
   * shows up in a size series.
   */
  signals: SignalRow[];
  samples: PerfSnapshot[];
}

export interface SignalRow {
  name: string;
  unit: "count" | "percent" | "ms";
  first: number;
  last: number;
  peak: number;
  /** For a cumulative counter this is "how many during the window". */
  delta: number;
}

export interface GrowthRow {
  name: string;
  firstMb: number;
  lastMb: number;
  peakMb: number;
  deltaMb: number;
  /** True when every sample was ≥ the one before it — a leak's signature. */
  monotonic: boolean;
}

export function stopRecording(reason: RecordingStopReason = "manual"): RecordingResult {
  if (!active) {
    throw new Error("기록 중이 아닙니다.");
  }
  const finished = active;
  clearInterval(finished.timer);
  active = null;
  last = {
    id: finished.id,
    startedAt: finished.startedAt,
    stoppedAt: Date.now(),
    reason,
    samples: finished.samples.length,
  };
  log("info", "perf", "recording stopped", { id: finished.id, reason, samples: finished.samples.length });
  return {
    ok: true,
    id: finished.id,
    startedAt: new Date(finished.startedAt).toISOString(),
    stoppedAt: new Date().toISOString(),
    stoppedReason: reason,
    applied: finished.budget,
    sampleCount: finished.samples.length,
    filePath: finished.filePath,
    growth: summarizeGrowth(finished.samples),
    signals: summarizeSignals(finished.samples),
    samples: finished.samples,
  };
}

/** Ends any recording at shutdown, so a forgotten one cannot outlive the app. */
export function stopRecordingForShutdown(): void {
  if (active) {
    try {
      stopRecording("shutdown");
    } catch {
      // Shutdown path: nothing useful left to report to.
    }
  }
}

async function tick(deps: PerfInspectorDeps): Promise<void> {
  const current = active;
  if (!current || current.collecting) {
    // A snapshot that outran its own interval (a very busy app) must not stack
    // up behind itself; skipping the tick is the honest response.
    return;
  }
  current.collecting = true;
  try {
    const snapshot = await collectPerfSnapshot(deps, { includeHarness: current.budget.includeHarness });
    current.samples.push(snapshot);
    if (current.filePath) {
      fs.appendFileSync(current.filePath, `${JSON.stringify(snapshot)}\n`, "utf8");
    }
    const elapsedMinutes = (Date.now() - current.startedAt) / 60_000;
    if (current.samples.length >= current.budget.maxSamples || elapsedMinutes >= current.budget.maxMinutes) {
      stopRecording("budget");
    }
  } catch (error) {
    log("error", "perf", "recording sample failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    current.collecting = false;
  }
}

/**
 * Turns the samples into the answer: per holder, what it started at, what it
 * peaked at, and whether it ever went down. A number that only ever rises is
 * what separates a leak from a busy hour.
 */
function summarizeGrowth(samples: PerfSnapshot[]): GrowthRow[] {
  if (samples.length === 0) {
    return [];
  }
  const series = new Map<string, number[]>();
  for (const sample of samples) {
    const add = (name: string, mb: number) => {
      const list = series.get(name) || [];
      list.push(mb);
      series.set(name, list);
    };
    add("process.total", sample.totals.processWorkingSetMb);
    add("process.attributed", sample.totals.attributedMb);
    add("process.residual", sample.totals.residualMb);
    add("main.rss", sample.main.rssMb);
    for (const bucket of sample.main.buckets) {
      add(`main.${bucket.name}`, bucket.estimate.approxBytes / (1024 * 1024));
    }
    for (const window of sample.windows) {
      if (window.jsHeapUsedMb !== undefined) {
        add(`${window.windowId}.jsHeap`, window.jsHeapUsedMb);
      }
      for (const bucket of window.buckets) {
        add(`${window.windowId}.${bucket.name}`, bucket.estimate.approxBytes / (1024 * 1024));
      }
    }
  }
  const rows: GrowthRow[] = [];
  for (const [name, values] of series) {
    const first = values[0];
    const lastValue = values[values.length - 1];
    rows.push({
      name,
      firstMb: round(first, 1),
      lastMb: round(lastValue, 1),
      peakMb: round(Math.max(...values), 1),
      deltaMb: round(lastValue - first, 1),
      monotonic: values.every((value, index) => index === 0 || value >= values[index - 1] - 0.5),
    });
  }
  return rows.sort((a, b) => b.deltaMb - a.deltaMb);
}

/**
 * The non-size series. Cumulative counters (long tasks, IPC sends) report their
 * delta as "how many happened in this window"; instantaneous ones (CPU,
 * event-loop lag) report their peak, which is what a user actually felt.
 */
function summarizeSignals(samples: PerfSnapshot[]): SignalRow[] {
  if (samples.length === 0) {
    return [];
  }
  const series = new Map<string, { unit: SignalRow["unit"]; values: number[] }>();
  const add = (name: string, unit: SignalRow["unit"], value: number) => {
    const entry = series.get(name) || { unit, values: [] };
    entry.values.push(value);
    series.set(name, entry);
  };
  for (const sample of samples) {
    add("eventLoop.p50", "ms", sample.eventLoop.p50Ms);
    add("eventLoop.max", "ms", sample.eventLoop.maxMs);
    for (const entry of sample.processes) {
      add(`cpu.${entry.label || entry.kind}`, "percent", entry.cpuPercent);
    }
    for (const [name, total] of Object.entries(sample.flow.totals)) {
      add(`flow.${name}`, "count", total);
    }
    for (const window of sample.windows) {
      if (window.longTasks) {
        add(`${window.windowId}.longTasks`, "count", window.longTasks.count);
        add(`${window.windowId}.longTaskMax`, "ms", window.longTasks.maxMs);
      }
      if (window.domNodes !== undefined) {
        add(`${window.windowId}.domNodes`, "count", window.domNodes);
      }
      for (const [name, total] of Object.entries(window.counters || {})) {
        add(`${window.windowId}.${name}`, "count", total);
      }
    }
  }
  const rows: SignalRow[] = [];
  for (const [name, entry] of series) {
    const values = entry.values;
    rows.push({
      name,
      unit: entry.unit,
      first: round(values[0], 1),
      last: round(values[values.length - 1], 1),
      peak: round(Math.max(...values), 1),
      delta: round(values[values.length - 1] - values[0], 1),
    });
  }
  // Busiest first: for counters that is the most traffic, for CPU and lag the
  // worst moment — either way, the row a reader should look at first.
  return rows.sort((a, b) => (b.unit === "count" ? b.delta : b.peak) - (a.unit === "count" ? a.delta : a.peak));
}

function clampBudget(request: Partial<RecordingBudget>, clamped: string[]): RecordingBudget {
  const clamp = (name: keyof RecordingBudget, value: number | undefined, fallback: number, min: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) {
      return fallback;
    }
    const bounded = Math.min(max, Math.max(min, value));
    if (bounded !== value) {
      clamped.push(`${name}: ${value} → ${bounded}`);
    }
    return bounded;
  };
  return {
    intervalMs: clamp("intervalMs", request.intervalMs, DEFAULTS.intervalMs, LIMITS.minIntervalMs, LIMITS.maxIntervalMs),
    maxSamples: clamp("maxSamples", request.maxSamples, DEFAULTS.maxSamples, 1, LIMITS.maxSamples),
    maxMinutes: clamp("maxMinutes", request.maxMinutes, DEFAULTS.maxMinutes, 1, LIMITS.maxMinutes),
    includeHarness: request.includeHarness ?? DEFAULTS.includeHarness,
    toDisk: request.toDisk ?? DEFAULTS.toDisk,
  };
}

/** Rough per-sample memory, for reporting a recording's own footprint. */
function approximateSampleKb(): number {
  return 1;
}

export function perfDir(): string {
  return path.join(getUserDataDir(), "perf");
}
