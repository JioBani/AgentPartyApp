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

export function log(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (level === "debug" && !debugLoggingEnabled) {
    return;
  }
  const entry: LogEntry = { at: new Date().toISOString(), level, scope, message, data: redact(data) };
  const line = JSON.stringify(entry) + "\n";
  try {
    const file = logFilePath || getLogFilePath();
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // Logging must never break the app.
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
