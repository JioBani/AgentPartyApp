import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

let logFilePath = "";
let debugLoggingEnabled = false;
let consoleLogging = true;

/**
 * Toggles console output (file logging is unaffected). The engine server turns
 * this off because it uses stdout as its RPC channel — stray console.log would
 * corrupt the protocol. See the WSL remote-engine design §7.
 */
export function setConsoleLogging(enabled: boolean): void {
  consoleLogging = enabled;
}

export function initLogger(): string {
  const dir = path.join(getUserDataDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, `agentparty-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
  log("info", "app", "logger initialized", { logFilePath });
  return logFilePath;
}

export function getLogFilePath(): string {
  return logFilePath || initLogger();
}

export function setDebugLoggingEnabled(enabled: boolean): void {
  debugLoggingEnabled = enabled;
}

/**
 * Appends one line to the log file. Returns `""` when it landed, or the reason
 * it did not — `appendFileSync` is synchronous, so a successful return means the
 * bytes are on disk, which is what lets the crash handler log and exit
 * immediately without an explicit flush step.
 */
function appendLine(line: string): string {
  try {
    fs.appendFileSync(logFilePath || getLogFilePath(), line, "utf8");
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Records an entry whose loss would be the whole problem — a crash report.
 *
 * Differs from {@link log} in one way: a failed file write is REPORTED on stderr
 * instead of swallowed. `log` may silently drop a line because logging must
 * never break the app; for a crash record that same silence means the crash
 * leaves no trace at all, which is the defect this exists to fix. The record
 * also always goes to stderr, so it survives even when the file is unwritable
 * (and stderr, unlike stdout, is never the engine server's RPC channel).
 */
export function logCritical(scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = { at: new Date().toISOString(), level: "error", scope, message, data: redact(data) };
  const line = JSON.stringify(entry) + "\n";
  const failure = appendLine(line);
  process.stderr.write(line);
  if (failure) {
    process.stderr.write(`[logger] could not write the record above to ${logFilePath || "(no log file)"}: ${failure}\n`);
  }
}

export function log(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (level === "debug" && !debugLoggingEnabled) {
    return;
  }
  const entry: LogEntry = { at: new Date().toISOString(), level, scope, message, data: redact(data) };
  // Logging must never break the app, so a write failure is dropped here. The
  // one place that cannot afford that is `logCritical`.
  appendLine(JSON.stringify(entry) + "\n");
  if (!consoleLogging) {
    return;
  }
  if (level === "error") {
    console.error(`[${scope}] ${message}`, data);
  } else if (level === "warn") {
    console.warn(`[${scope}] ${message}`, data);
  } else {
    console.log(`[${scope}] ${message}`, data || "");
  }
}

function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|authorization|password/i.test(key)) {
      output[key] = item ? "[redacted]" : item;
    } else {
      output[key] = redact(item);
    }
  }
  return output;
}
