/**
 * Deep captures — a heap snapshot or a CPU profile of the RUNNING app.
 *
 * The counters in `perfInspector` name what the app itself holds. When the
 * residual is large (working set the app cannot attribute) or a window has
 * stopped answering, the next question is one only V8 can answer, and the
 * answer used to require relaunching with a debug flag — which destroys the
 * state being investigated.
 *
 * It does not. Electron exposes both captures on a live window:
 *  - `webContents.takeHeapSnapshot` writes V8's heap to a file;
 *  - `webContents.debugger` speaks the DevTools protocol IN PROCESS, so a CPU
 *    profile needs no `--remote-debugging-port` and no restart.
 *
 * Both are expensive and both contain conversation text, so neither happens on
 * a timer, nothing is ever uploaded, and old artifacts are pruned to a couple
 * of files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../logger";
import { perfDir } from "./perfRecorder";
import type { WindowRegistry } from "../windowRegistry";

/** Artifacts kept per kind. They are ~100MB each; the newest are the useful ones. */
const KEEP_PER_KIND = 2;

/** Longest CPU profile we will take in one call. */
const MAX_PROFILE_MS = 60_000;

export interface CaptureResult {
  ok: true;
  kind: "heap" | "cpu";
  target: string;
  filePath: string;
  bytes: number;
  ms: number;
  /** Files removed to stay within the retention limit. */
  pruned: string[];
  warning: string;
}

const PRIVACY_WARNING =
  "이 파일에는 대화 내용과 파일 경로가 그대로 들어 있습니다. 로컬에서만 열고, 공유 전에 반드시 확인하세요.";

export async function captureHeapSnapshot(
  registry: WindowRegistry,
  target: string,
): Promise<CaptureResult> {
  const started = Date.now();
  const filePath = artifactPath("heap", target, "heapsnapshot");
  if (target === "main") {
    // The main process cannot be asked from outside, so it writes its own.
    const v8 = await import("node:v8");
    v8.writeHeapSnapshot(filePath);
  } else {
    const entry = requireWindow(registry, target);
    await entry.window.webContents.takeHeapSnapshot(filePath);
  }
  const bytes = fs.statSync(filePath).size;
  log("info", "perf", "heap snapshot written", { target, filePath, bytes });
  return {
    ok: true,
    kind: "heap",
    target,
    filePath,
    bytes,
    ms: Date.now() - started,
    pruned: prune("heap"),
    warning: PRIVACY_WARNING,
  };
}

/**
 * Records a CPU profile of one window for `ms`, through the in-process
 * debugger. The window keeps running while it is profiled — this is a sampling
 * profiler, not a pause — which is what makes it usable on an app that is
 * misbehaving right now.
 */
export async function captureCpuProfile(
  registry: WindowRegistry,
  target: string,
  ms: number,
): Promise<CaptureResult> {
  const entry = requireWindow(registry, target);
  const duration = Math.min(MAX_PROFILE_MS, Math.max(500, Math.round(ms)));
  const contents = entry.window.webContents;
  const started = Date.now();
  const alreadyAttached = contents.debugger.isAttached();
  if (!alreadyAttached) {
    contents.debugger.attach("1.3");
  }
  try {
    await contents.debugger.sendCommand("Profiler.enable");
    await contents.debugger.sendCommand("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, duration));
    const { profile } = await contents.debugger.sendCommand("Profiler.stop") as { profile: unknown };
    await contents.debugger.sendCommand("Profiler.disable");
    const filePath = artifactPath("cpu", target, "cpuprofile");
    fs.writeFileSync(filePath, JSON.stringify(profile), "utf8");
    const bytes = fs.statSync(filePath).size;
    log("info", "perf", "cpu profile written", { target, filePath, bytes, durationMs: duration });
    return {
      ok: true,
      kind: "cpu",
      target,
      filePath,
      bytes,
      ms: Date.now() - started,
      pruned: prune("cpu"),
      warning: PRIVACY_WARNING,
    };
  } finally {
    // Detach even on failure: an attached debugger keeps the DevTools protocol
    // session open on that window, which is overhead the user never asked for.
    if (!alreadyAttached && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
  }
}

/** Artifacts on disk right now, so a caller can find or delete them. */
export function listCaptures(): Array<{ file: string; bytes: number; at: string }> {
  const dir = perfDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".heapsnapshot") || file.endsWith(".cpuprofile"))
    .map((file) => {
      const stat = fs.statSync(path.join(dir, file));
      return { file: path.join(dir, file), bytes: stat.size, at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

function requireWindow(registry: WindowRegistry, target: string) {
  const entry = registry.get(target) || registry.resolve(target === "focused" ? undefined : target);
  if (!entry || entry.window.isDestroyed()) {
    const open = registry.list().map((window) => window.id).join(", ") || "없음";
    throw new Error(`대상 창 '${target}'을 찾을 수 없습니다. 열린 창: ${open} (메인 프로세스는 'main').`);
  }
  return entry;
}

function artifactPath(kind: "heap" | "cpu", target: string, extension: string): string {
  const dir = perfDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${kind}-${target}-${stamp}.${extension}`);
}

/** Keeps only the newest few artifacts of a kind; returns what it deleted. */
function prune(kind: "heap" | "cpu"): string[] {
  const extension = kind === "heap" ? ".heapsnapshot" : ".cpuprofile";
  const files = listCaptures().filter((entry) => entry.file.endsWith(extension));
  const removed: string[] = [];
  for (const entry of files.slice(KEEP_PER_KIND)) {
    try {
      fs.rmSync(entry.file, { force: true });
      removed.push(entry.file);
    } catch (error) {
      log("warn", "perf", "could not prune capture", { file: entry.file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return removed;
}
