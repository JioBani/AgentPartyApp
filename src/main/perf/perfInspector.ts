/**
 * What the running app is spending memory and time on, answered at the moment
 * it is asked.
 *
 * This exists because the interesting failures — a window that has grown to
 * gigabytes, a freeze, a slow drift — cannot be reproduced by restarting into a
 * debug build: restarting IS the fix, and it destroys the state that was the
 * evidence. So the SHIPPED app has to be able to answer, and answer with enough
 * detail to name the element responsible.
 *
 * Nothing here runs on its own. There is no sampler, no rolling log, no
 * accumulating counter — a report costs a few milliseconds when someone asks
 * for one and nothing at all when nobody does. That is only affordable because
 * measuring a string is a field read, not a scan (see `shared/perfMeasure.ts`).
 */

import type { BrowserWindow } from "electron";
import { performance } from "node:perf_hooks";
import { collectMemoryBuckets, registeredProbeNames } from "../../shared/memoryProbes";
import type { MemoryBucket } from "../../shared/perfMeasure";
import { log } from "../logger";
import type { WindowRegistry } from "../windowRegistry";

const MB = 1024 * 1024;

/** One OS process, as Chromium accounts for it. */
export interface PerfProcessSample {
  /** `Browser` (main), `Tab` (a window), `GPU`, `Utility`, `harness` (a CLI we spawned). */
  kind: string;
  pid: number;
  /** Set for `Tab` rows we could match to a window, and for harness rows. */
  label?: string;
  cpuPercent: number;
  workingSetMb: number;
}

/** What one window is holding, as that window itself reports it. */
export interface PerfWindowReport {
  windowId: string;
  workspace: string;
  /**
   * False when the window did not answer within the timeout — which is not a
   * failed report but the finding itself: this is what a frozen renderer looks
   * like from outside, and the moment to take a CPU profile of it.
   */
  responsive: boolean;
  replyMs: number;
  jsHeapUsedMb?: number;
  jsHeapLimitMb?: number;
  domNodes?: number;
  buckets: MemoryBucket[];
  error?: string;
}

export interface PerfSnapshot {
  at: string;
  uptimeSec: number;
  /** Main-process totals, from Node's own accounting. */
  main: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    buckets: MemoryBucket[];
    probes: string[];
  };
  processes: PerfProcessSample[];
  windows: PerfWindowReport[];
  /**
   * Main-thread responsiveness, measured over a short burst. A jammed main
   * process is why the whole app "freezes" — including the windows, which can
   * only paint what main lets through.
   */
  eventLoop: { samples: number; p50Ms: number; maxMs: number };
  totals: {
    /** Everything Chromium accounts for, plus any harness processes sampled. */
    processWorkingSetMb: number;
    /** What the app can NAME: the sum of every bucket every probe reported. */
    attributedMb: number;
    /**
     * Working set the app cannot name. A large residual is itself the answer:
     * the growth is not in our own maps, so the next step is a heap snapshot
     * rather than more counters.
     */
    residualMb: number;
  };
  notes: string[];
}

export interface PerfInspectorDeps {
  windowRegistry: WindowRegistry;
  /**
   * Harness CLIs the app has spawned. They are separate OS processes that
   * Chromium's own metrics know nothing about, and they can hold more memory
   * than the app does — leaving them out would attribute their cost to nobody.
   */
  listHarnessProcesses?: () => Promise<Array<{ pid: number; label: string }>>;
}

/**
 * The function each window installs so this side can ask it what it holds.
 * Called through `executeJavaScript` rather than an IPC channel for one
 * reason: a hung renderer must not hang the report, and this way the timeout
 * lives entirely on this side.
 */
const RENDERER_PROBE_CALL = "window.__agentpartyPerf ? JSON.stringify(window.__agentpartyPerf()) : null";

/** How long a window gets to answer before it is reported as unresponsive. */
const WINDOW_TIMEOUT_MS = 1_500;

export async function collectPerfSnapshot(
  deps: PerfInspectorDeps,
  options: { includeHarness?: boolean; windowTimeoutMs?: number } = {},
): Promise<PerfSnapshot> {
  const notes: string[] = [];
  const memory = process.memoryUsage();
  const mainBuckets = collectMemoryBuckets();

  const windows = await Promise.all(
    deps.windowRegistry.all().map((entry) => askWindow(entry.id, entry.workspacePath, entry.window, options.windowTimeoutMs)),
  );

  // Imported here, not at the top: this controller also loads inside a WSL
  // distro's headless engine, which runs under plain node where `electron` does
  // not exist. An eager import would break that bundle (the build checks).
  const { app } = await import("electron");
  const processes: PerfProcessSample[] = app.getAppMetrics().map((metric) => ({
    kind: metric.type,
    pid: metric.pid,
    label: labelForPid(metric.pid, deps.windowRegistry),
    cpuPercent: round(metric.cpu?.percentCPUUsage ?? 0, 1),
    workingSetMb: round((metric.memory?.workingSetSize ?? 0) / 1024, 1),
  }));

  if (options.includeHarness !== false && deps.listHarnessProcesses) {
    try {
      const harness = await deps.listHarnessProcesses();
      const sampled = await sampleExternalProcesses(harness);
      processes.push(...sampled);
      if (harness.length > 0 && sampled.length === 0) {
        notes.push("하네스 프로세스 메모리를 읽지 못했습니다(권한 또는 조회 실패).");
      }
    } catch (error) {
      notes.push(`하네스 프로세스 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const eventLoop = await measureEventLoopLag();

  const attributedMb = round(
    [...mainBuckets, ...windows.flatMap((window) => window.buckets)]
      .reduce((sum, bucket) => sum + bucket.estimate.approxBytes, 0) / MB,
    1,
  );
  const processWorkingSetMb = round(processes.reduce((sum, entry) => sum + entry.workingSetMb, 0), 1);

  if (windows.some((window) => !window.responsive)) {
    notes.push("응답하지 않는 창이 있습니다 — 그 창의 수치는 비어 있고, 지금이 CPU 프로파일을 뜰 시점입니다.");
  }
  if (windows.length === 0) {
    notes.push("열린 창이 없어 렌더러 보유량은 이 보고에 없습니다.");
  }

  return {
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    main: {
      rssMb: round(memory.rss / MB, 1),
      heapUsedMb: round(memory.heapUsed / MB, 1),
      heapTotalMb: round(memory.heapTotal / MB, 1),
      externalMb: round(memory.external / MB, 1),
      buckets: mainBuckets,
      probes: registeredProbeNames(),
    },
    processes,
    windows,
    eventLoop,
    totals: {
      processWorkingSetMb,
      attributedMb,
      residualMb: round(Math.max(0, processWorkingSetMb - attributedMb), 1),
    },
    notes,
  };
}

/**
 * Asks one window what it holds, with a deadline.
 *
 * The deadline is the whole point: `executeJavaScript` on a renderer stuck in a
 * long task never settles, and a perf report that hangs exactly when the app is
 * stuck would be useless precisely when it is needed.
 */
async function askWindow(
  windowId: string,
  workspace: string,
  window: BrowserWindow,
  timeoutMs = WINDOW_TIMEOUT_MS,
): Promise<PerfWindowReport> {
  const started = performance.now();
  const base: PerfWindowReport = { windowId, workspace, responsive: false, replyMs: 0, buckets: [] };
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return { ...base, error: "창이 이미 닫혔습니다." };
  }
  if (window.webContents.isCrashed()) {
    return { ...base, error: "렌더러 프로세스가 죽어 있습니다." };
  }
  try {
    const raw = await withTimeout(window.webContents.executeJavaScript(RENDERER_PROBE_CALL, true), timeoutMs);
    const replyMs = round(performance.now() - started, 0);
    if (raw === null || raw === undefined) {
      // An older renderer, or one still booting: it has not installed the probe.
      return { ...base, responsive: true, replyMs, error: "이 창은 메모리 프로브를 아직 등록하지 않았습니다." };
    }
    const parsed = JSON.parse(String(raw)) as {
      buckets?: MemoryBucket[];
      jsHeapUsedMb?: number;
      jsHeapLimitMb?: number;
      domNodes?: number;
    };
    return {
      windowId,
      workspace,
      responsive: true,
      replyMs,
      jsHeapUsedMb: parsed.jsHeapUsedMb,
      jsHeapLimitMb: parsed.jsHeapLimitMb,
      domNodes: parsed.domNodes,
      buckets: parsed.buckets || [],
    };
  } catch (error) {
    return {
      ...base,
      replyMs: round(performance.now() - started, 0),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * How late timers are running, sampled over a short burst.
 *
 * Reported rather than judged: a p50 of a millisecond is a healthy loop, and
 * hundreds of milliseconds is a main thread that cannot keep up — which is what
 * the user experiences as the app hanging.
 */
async function measureEventLoopLag(sampleCount = 8, intervalMs = 15): Promise<{ samples: number; p50Ms: number; maxMs: number }> {
  const lags: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    lags.push(Math.max(0, performance.now() - start - intervalMs));
  }
  const sorted = [...lags].sort((a, b) => a - b);
  return {
    samples: lags.length,
    p50Ms: round(sorted[Math.floor(sorted.length / 2)] ?? 0, 1),
    maxMs: round(sorted[sorted.length - 1] ?? 0, 1),
  };
}

/**
 * Working set for processes Chromium does not account for — the harness CLIs.
 *
 * One PowerShell call for every pid at once, because spawning per process would
 * cost more than the measurement is worth. Only ever on request.
 */
async function sampleExternalProcesses(targets: Array<{ pid: number; label: string }>): Promise<PerfProcessSample[]> {
  if (targets.length === 0 || process.platform !== "win32") {
    return [];
  }
  const { execFile } = await import("node:child_process");
  const ids = targets.map((target) => target.pid).join(",");
  const script = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`;
  const output = await new Promise<string>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 4_000, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
  if (!output.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(output) as { Id: number; WorkingSet64: number } | Array<{ Id: number; WorkingSet64: number }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      kind: "harness",
      pid: row.Id,
      label: targets.find((target) => target.pid === row.Id)?.label,
      cpuPercent: 0,
      workingSetMb: round(row.WorkingSet64 / MB, 1),
    }));
  } catch (error) {
    log("warn", "perf", "harness process sample unreadable", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function labelForPid(pid: number, registry: WindowRegistry): string | undefined {
  for (const entry of registry.all()) {
    if (!entry.window.isDestroyed() && entry.window.webContents.getOSProcessId() === pid) {
      return entry.id;
    }
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${ms}ms 안에 응답하지 않았습니다.`)), ms)),
  ]);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
