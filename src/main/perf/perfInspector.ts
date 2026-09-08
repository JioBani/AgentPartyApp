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
import * as fsSync from "node:fs";
import * as pathModule from "node:path";
import { performance } from "node:perf_hooks";
import { collectMemoryBuckets, registeredProbeNames } from "../../shared/memoryProbes";
import { counterRates, readCounters, type CounterReading } from "../../shared/perfCounters";
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
  /**
   * CPU over the measurement window, computed from cumulative CPU seconds.
   *
   * Electron's own `percentCPUUsage` is "since the last call" and the metrics
   * objects are rebuilt on every call, so it reported ~0% for a process that
   * was pinning a core — measured here while an emit storm was running. Two
   * readings a known interval apart is the only number that means anything.
   */
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
  /** Monotonic totals this window keeps (events applied, batches). */
  counters?: Record<string, number>;
  /** Tasks over 50ms — the direct evidence of "the window feels stuck". */
  longTasks?: { count: number; totalMs: number; maxMs: number; lastAt?: number };
  /**
   * Cumulative renderer timing from the DevTools protocol (`?deep=1`): script,
   * layout and style seconds, node and listener counts. Answers WHERE a busy
   * renderer's time goes, which no size or count can.
   */
  timing?: Record<string, number>;
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
  /**
   * On-disk party store (`?disk=1`). What a window will LOAD, as opposed to
   * what it currently holds — the reason a fresh window on a big party is
   * expensive the moment it opens.
   */
  disk?: { rootMb: number; parties: Array<{ name: string; mb: number; files: number }>; scannedFiles: number; truncated: boolean };
  eventLoop: { samples: number; p50Ms: number; maxMs: number };
  /**
   * What is FLOWING: monotonic totals plus the per-second rate since the last
   * snapshot this process produced. Sizes cannot show a busy app; rates can.
   */
  flow: { totals: Record<string, number>; ratesPerSec: Record<string, number>; sinceMs?: number; rejectedNames: number };
  /**
   * Every measured holder, largest first, across both processes — the one list
   * to read when the question is "what is using the RAM". The per-process
   * detail below is for following up on whatever this names.
   */
  topHolders: Array<{ name: string; mb: number; where: string; entries?: number; topKey?: string; truncated: boolean }>;
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
   * Where the party store lives. Its size on disk is the best predictor of what
   * a window will pull into memory: opening a party parses that party's files,
   * so a 46MB party is a 46MB window, before anything else it holds.
   */
  partyStoreDir?: string;
  /**
   * Harness CLIs the app has spawned. They are separate OS processes that
   * Chromium's own metrics know nothing about, and they can hold more memory
   * than the app does — leaving them out would attribute their cost to nobody.
   */
  listHarnessProcesses?: () => Promise<{ processes: Array<{ pid: number; label: string }>; withoutPid: string[] }>;
}

/**
 * The function each window installs so this side can ask it what it holds.
 * Called through `executeJavaScript` rather than an IPC channel for one
 * reason: a hung renderer must not hang the report, and this way the timeout
 * lives entirely on this side.
 */
const RENDERER_PROBE_CALL = "window.__agentpartyPerf ? JSON.stringify(window.__agentpartyPerf()) : null";

/** The window over which `?deep=1` measures renderer time. */
const TIMING_WINDOW_MS = 400;

/** How long a window gets to answer before it is reported as unresponsive. */
const WINDOW_TIMEOUT_MS = 1_500;

/** Counters as of the previous snapshot, so this one can report rates. */
let previousCounters: CounterReading | undefined;

export async function collectPerfSnapshot(
  deps: PerfInspectorDeps,
  options: { includeHarness?: boolean; windowTimeoutMs?: number; deep?: boolean; disk?: boolean } = {},
): Promise<PerfSnapshot> {
  const notes: string[] = [];
  const memory = process.memoryUsage();
  const mainBuckets = collectMemoryBuckets();

  // Imported here, not at the top: this controller also loads inside a WSL
  // distro's headless engine, which runs under plain node where `electron` does
  // not exist. An eager import would break that bundle (the build checks).
  const { app } = await import("electron");
  // CPU needs two readings. The first is taken BEFORE the work below so the
  // event-loop probe's own wait doubles as the measurement interval — the
  // report costs no extra time for it.
  const firstCpu = cpuSecondsByPid(app.getAppMetrics());
  const firstAt = performance.now();

  const windows = await Promise.all(
    deps.windowRegistry.all().map((entry) => askWindow(entry.id, entry.workspacePath, entry.window, options.windowTimeoutMs)),
  );
  const eventLoop = await measureEventLoopLag();
  if (options.deep) {
    await Promise.all(deps.windowRegistry.all().map(async (entry) => {
      const report = windows.find((window) => window.windowId === entry.id);
      if (report?.responsive) {
        report.timing = await readRendererTiming(entry.window, notes);
      }
    }));
  }

  const secondMetrics = app.getAppMetrics();
  const elapsedSec = Math.max(0.001, (performance.now() - firstAt) / 1000);
  const processes: PerfProcessSample[] = secondMetrics.map((metric) => {
    const before = firstCpu.get(metric.pid);
    const after = metric.cpu?.cumulativeCPUUsage;
    const cpuPercent = before !== undefined && after !== undefined
      ? round(((after - before) / elapsedSec) * 100, 1)
      : round(metric.cpu?.percentCPUUsage ?? 0, 1);
    return {
      kind: metric.type,
      pid: metric.pid,
      label: labelForPid(metric.pid, deps.windowRegistry),
      cpuPercent,
      workingSetMb: round((metric.memory?.workingSetSize ?? 0) / 1024, 1),
    };
  });

  if (options.includeHarness !== false && deps.listHarnessProcesses) {
    try {
      const harness = await deps.listHarnessProcesses();
      const sampled = await sampleExternalProcesses(harness.processes);
      processes.push(...sampled);
      if (harness.processes.length > 0 && sampled.length === 0) {
        notes.push("하네스 프로세스 메모리를 읽지 못했습니다(권한 또는 조회 실패).");
      }
      // Said out loud rather than left as an empty list: a Claude member runs
      // through an in-process SDK, so it HAS no separate process and its cost
      // sits inside the app's own numbers. Silence here would read as "no
      // harness is using anything", which is a different and wrong claim.
      if (harness.withoutPid.length > 0) {
        notes.push(
          `세션 ${harness.withoutPid.length}개(${harness.withoutPid.slice(0, 5).join(", ")})는 별도 프로세스 id가 없어 `
          + "프로세스 단위로 귀속되지 않습니다 — 인프로세스 SDK 하네스이며, 그 비용은 위 앱 프로세스 수치에 포함되어 있습니다.",
        );
      }
    } catch (error) {
      notes.push(`하네스 프로세스 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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

  const topHolders = [
    ...mainBuckets.map((bucket) => ({ bucket, where: "main" })),
    ...windows.flatMap((window) => window.buckets.map((bucket) => ({ bucket, where: window.windowId }))),
  ]
    .map(({ bucket, where }) => ({
      name: bucket.name,
      where,
      mb: round(bucket.estimate.approxBytes / MB, 1),
      entries: bucket.entries,
      topKey: bucket.top?.[0]?.key,
      truncated: bucket.estimate.truncated,
    }))
    .sort((a, b) => b.mb - a.mb)
    .slice(0, 12);

  const disk = options.disk && deps.partyStoreDir ? measurePartyStore(deps.partyStoreDir) : undefined;
  if (options.disk && !deps.partyStoreDir) {
    notes.push("파티 저장소 경로를 알 수 없어 디스크 사용량을 재지 못했습니다.");
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
    topHolders,
    ...(disk ? { disk } : {}),
    eventLoop,
    flow: flowSince(),
    totals: {
      processWorkingSetMb,
      attributedMb,
      residualMb: round(Math.max(0, processWorkingSetMb - attributedMb), 1),
    },
    notes,
  };
}

interface HarnessRow { Id: number; WorkingSet64: number; CPU?: number }

/**
 * Last CPU reading per harness pid, so the next one can report a rate. Only
 * pids we sampled are kept, and a dead pid simply stops being asked about —
 * the map cannot outgrow the number of live members.
 */
const harnessCpuSeconds = new Map<number, { seconds: number; at: number }>();

/**
 * Party files on disk, by party.
 *
 * Opt-in because it walks a directory tree, and bounded by a file budget so a
 * store that has grown pathological — the exact case worth measuring — cannot
 * make the measurement pathological too.
 */
function measurePartyStore(root: string): PerfSnapshot["disk"] {
  const budget = 20_000;
  let scanned = 0;
  const sizeOf = (dir: string): { bytes: number; files: number } => {
    let bytes = 0;
    let files = 0;
    let entries: import("node:fs").Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { bytes, files };
    }
    for (const entry of entries) {
      if (scanned >= budget) {
        break;
      }
      const full = pathModule.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = sizeOf(full);
        bytes += nested.bytes;
        files += nested.files;
        continue;
      }
      scanned += 1;
      files += 1;
      try {
        bytes += fsSync.statSync(full).size;
      } catch {
        // A file removed mid-walk is not a measurement failure.
      }
    }
    return { bytes, files };
  };
  const partiesDir = pathModule.join(root, "parties");
  let parties: Array<{ name: string; mb: number; files: number }> = [];
  try {
    parties = fsSync.readdirSync(partiesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const measured = sizeOf(pathModule.join(partiesDir, entry.name));
        return { name: entry.name, mb: round(measured.bytes / MB, 1), files: measured.files };
      })
      .sort((a, b) => b.mb - a.mb)
      .slice(0, 10);
  } catch {
    parties = [];
  }
  const total = sizeOf(root);
  return { rootMb: round(total.bytes / MB, 1), parties, scannedFiles: scanned, truncated: scanned >= budget };
}

/** CPU seconds per pid, for the delta the next reading turns into a percentage. */
function cpuSecondsByPid(metrics: Array<{ pid: number; cpu?: { cumulativeCPUUsage?: number } }>): Map<number, number> {
  const seconds = new Map<number, number>();
  for (const metric of metrics) {
    if (metric.cpu?.cumulativeCPUUsage !== undefined) {
      seconds.set(metric.pid, metric.cpu.cumulativeCPUUsage);
    }
  }
  return seconds;
}

/**
 * Totals and the rate since the previous snapshot.
 *
 * Only the last reading is kept — one small object — because a rate needs two
 * points, not a history. A recording gets its series by differencing its own
 * samples instead of this side storing one.
 */
function flowSince(): PerfSnapshot["flow"] {
  const current = readCounters();
  const rates = counterRates(previousCounters, current);
  const sinceMs = previousCounters ? current.at - previousCounters.at : undefined;
  previousCounters = current;
  return { totals: current.totals, ratesPerSec: rates, sinceMs, rejectedNames: current.rejectedNames };
}

/**
 * Cumulative renderer timing, through the in-process DevTools protocol.
 *
 * Opt-in (`?deep=1`) because it attaches a debugger session for the length of
 * the call. `ScriptDuration`/`LayoutDuration`/`RecalcStyleDuration` are what
 * separate "our JavaScript is slow" from "the DOM this transcript builds is
 * slow" — a distinction no size or count in this report can make.
 */
async function readRendererTiming(window: BrowserWindow, notes: string[]): Promise<Record<string, number> | undefined> {
  const contents = window.webContents;
  const alreadyAttached = contents.debugger.isAttached();
  try {
    if (!alreadyAttached) {
      contents.debugger.attach("1.3");
    }
    await contents.debugger.sendCommand("Performance.enable");
    // The duration metrics are cumulative counters, and they start from the
    // moment the domain is enabled: reading them straight away reported zero
    // for everything, which looked like an idle renderer rather than an
    // unmeasured one. Two reads around a short window give the only numbers
    // that mean anything — how much of THAT window went to script and layout.
    const first = await readMetrics(contents);
    await new Promise((resolve) => setTimeout(resolve, TIMING_WINDOW_MS));
    const second = await readMetrics(contents);
    await contents.debugger.sendCommand("Performance.disable");
    const timing: Record<string, number> = { windowMs: TIMING_WINDOW_MS };
    for (const name of ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"]) {
      // Seconds of CPU inside the window, reported as a percentage of it: 40%
      // script time is a renderer that is busy, whatever it is holding.
      const seconds = (second[name] ?? 0) - (first[name] ?? 0);
      timing[`${name}Ms`] = round(seconds * 1000, 1);
      timing[`${name}Pct`] = round((seconds * 1000 / TIMING_WINDOW_MS) * 100, 1);
    }
    for (const name of ["LayoutCount", "RecalcStyleCount"]) {
      timing[name] = round((second[name] ?? 0) - (first[name] ?? 0), 0);
    }
    // Gauges, not counters: the current size of the page, which is the other
    // half of a slow renderer (a transcript can be small in bytes and enormous
    // in nodes).
    for (const name of ["Nodes", "JSEventListeners", "Documents", "Frames"]) {
      timing[name] = round(second[name] ?? 0, 0);
    }
    return timing;
  } catch (error) {
    notes.push(`렌더러 타이밍(deep) 실패: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    if (!alreadyAttached && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
  }
}

/** One `Performance.getMetrics` read, flattened to name → value. */
async function readMetrics(contents: BrowserWindow["webContents"]): Promise<Record<string, number>> {
  const result = await withTimeout(
    contents.debugger.sendCommand("Performance.getMetrics") as Promise<{ metrics: Array<{ name: string; value: number }> }>,
    2_000,
  );
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
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
      counters?: Record<string, number>;
      longTasks?: { count: number; totalMs: number; maxMs: number; lastAt?: number };
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
      counters: parsed.counters,
      longTasks: parsed.longTasks,
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
  // `CPU` is total processor SECONDS since the process started. On its own that
  // says nothing (an old process has a big number); against the previous
  // reading it becomes the percentage that matters — a member's CLI pinning a
  // core used to be reported at 0%, which is the one number that would have
  // sent an investigation in the wrong direction.
  const script = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,CPU | ConvertTo-Json -Compress`;
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
    const parsed = JSON.parse(output) as HarnessRow | HarnessRow[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();
    return rows.map((row) => {
      const previous = harnessCpuSeconds.get(row.Id);
      const cpuSeconds = typeof row.CPU === "number" ? row.CPU : undefined;
      let cpuPercent = 0;
      if (cpuSeconds !== undefined && previous && now > previous.at) {
        cpuPercent = round(((cpuSeconds - previous.seconds) / ((now - previous.at) / 1000)) * 100, 1);
      }
      if (cpuSeconds !== undefined) {
        harnessCpuSeconds.set(row.Id, { seconds: cpuSeconds, at: now });
      }
      return {
        kind: "harness",
        pid: row.Id,
        label: targets.find((target) => target.pid === row.Id)?.label,
        cpuPercent,
        workingSetMb: round(row.WorkingSet64 / MB, 1),
      };
    });
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
