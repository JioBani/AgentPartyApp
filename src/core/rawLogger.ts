import * as fs from "node:fs";
import * as path from "node:path";

export interface RawLoggerOptions {
  baseDir: string;
  sessionId: string;
  maxFiles: number;
  maxBytes: number;
  /**
   * Called at most once, with a human-readable reason, when raw logging stops
   * because the file could not be written. Callers surface it — a diagnostic
   * that fails silently is the thing this module is supposed to prevent.
   */
  onDisabled?: (reason: string) => void;
}

/**
 * Append-only transcript of what actually crossed the harness boundary, written
 * only while debug mode is on.
 *
 * It never throws. This is a debugging aid, and an aid that can take the app
 * down with it is worse than no aid at all: `write` is called from a harness
 * stdout handler, where a rejected append surfaces as an uncaught exception and
 * an Electron "A JavaScript error occurred in the main process" dialog — the
 * whole app dies because one log line could not be stored. Seen for real when a
 * running session's storage directory was deleted underneath it; the same shape
 * arrives from a full disk or a file locked by another process.
 *
 * A failure disables THIS logger and reports once, rather than retrying per
 * line: the causes are sticky, so retrying would repeat the report forever.
 */
export class RawLogger {
  readonly filePath: string;
  private bytes = 0;
  private closed = false;

  private constructor(private readonly options: RawLoggerOptions, filePath: string) {
    this.filePath = filePath;
  }

  /** Opens a logger, or reports and returns undefined if the location is unusable. */
  static open(options: RawLoggerOptions): RawLogger | undefined {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(options.baseDir, `${stamp}-${sanitize(options.sessionId)}.ndjson`);
    try {
      fs.mkdirSync(options.baseDir, { recursive: true });
      pruneLogs(options.baseDir, options.maxFiles);
      fs.closeSync(fs.openSync(filePath, "a"));
    } catch (error) {
      options.onDisabled?.(`could not open ${filePath}: ${reason(error)}`);
      return undefined;
    }
    return new RawLogger(options, filePath);
  }

  write(direction: string, payload: unknown): void {
    if (this.closed || this.bytes >= this.options.maxBytes) {
      return;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), direction, payload }) + "\n";
    this.bytes += Buffer.byteLength(line, "utf8");
    try {
      fs.appendFileSync(this.filePath, line);
    } catch (error) {
      // `close()` before reporting: the callback emits an event, which can reach
      // back into a writer, and a second failure must not report twice.
      this.close();
      this.options.onDisabled?.(`could not write ${this.filePath}: ${reason(error)}`);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pruneLogs(dir: string, maxFiles: number): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ndjson"))
    .map((name) => {
      const fullPath = path.join(dir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files.slice(Math.max(0, maxFiles - 1))) {
    try {
      fs.rmSync(file.fullPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}
