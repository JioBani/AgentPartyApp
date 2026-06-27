import * as fs from "node:fs";
import * as path from "node:path";

export interface RawLoggerOptions {
  baseDir: string;
  sessionId: string;
  maxFiles: number;
  maxBytes: number;
}

export class RawLogger {
  readonly filePath: string;
  private bytes = 0;
  private closed = false;

  constructor(private readonly options: RawLoggerOptions) {
    fs.mkdirSync(options.baseDir, { recursive: true });
    pruneLogs(options.baseDir, options.maxFiles);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(options.baseDir, `${stamp}-${sanitize(options.sessionId)}.ndjson`);
    fs.closeSync(fs.openSync(this.filePath, "a"));
  }

  write(direction: string, payload: unknown): void {
    if (this.closed || this.bytes >= this.options.maxBytes) {
      return;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), direction, payload }) + "\n";
    this.bytes += Buffer.byteLength(line, "utf8");
    fs.appendFileSync(this.filePath, line);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
  }
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
