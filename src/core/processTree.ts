import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Stops exactly one owned process tree and waits until its root is gone.
 * Harness CLIs commonly use a JS launcher that owns the native writer process;
 * killing only the launcher can leave the child holding the conversation lock.
 */
export function terminateProcessTree(pid: number, timeoutMs = 2_000): void {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    waitUntilGone(pid, timeoutMs);
    if (processExists(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      waitUntilGone(pid, 500);
    }
  } else {
    const descendants = linuxDescendants(pid);
    for (const child of descendants) {
      try { process.kill(child, "SIGTERM"); } catch { /* already gone */ }
    }
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    pause(100);
    for (const child of descendants) {
      if (processExists(child)) {
        try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    if (processExists(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    pause(100);
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function linuxDescendants(pid: number, seen = new Set<number>()): number[] {
  if (process.platform === "win32" || seen.has(pid)) return [];
  seen.add(pid);
  try {
    const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    const direct = raw ? raw.split(/\s+/u).map(Number).filter((value) => Number.isInteger(value) && value > 0) : [];
    return direct.flatMap((child) => [...linuxDescendants(child, seen), child]);
  } catch {
    return [];
  }
}

function waitUntilGone(pid: number, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) {
    // Synchronous by design: disposal must finish before another writer starts.
    pause(25);
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
