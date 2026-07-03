import { spawn } from "node:child_process";
import readline from "node:readline";
import { normalizeCodexModels, type CodexModelInfo } from "../shared/codexModels";
import { codexExecutable, codexExtraArgs, resolveCodexExecutable } from "./codexExec";

/**
 * Live Codex account-catalog discovery: spawns a short-lived `codex app-server`,
 * performs the initialize handshake, pages through `model/list`, and returns the
 * normalized visible models (docs/codex-ux-research/07-model-routing.md §1).
 *
 * Failures reject with a descriptive error — the caller must surface it (project
 * no-silent-fallback rule), not swallow it.
 */

export interface CodexModelDiscoveryOptions {
  cwd: string;
  executablePath?: string;
  executableArgs?: string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20000;

export async function discoverCodexModels(options: CodexModelDiscoveryOptions): Promise<CodexModelInfo[]> {
  const requested = codexExecutable(options.executablePath);
  const resolved = resolveCodexExecutable(requested);
  const args = [...codexExtraArgs(options.executableArgs), "app-server"];

  const child = spawn(resolved.command, args, {
    cwd: options.cwd,
    env: process.env,
    windowsHide: true,
    shell: resolved.shell,
  });

  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let seq = 0;
  let settledExit: Error | undefined;
  const stderrTail: string[] = [];

  const lineReader = readline.createInterface({ input: child.stdout });
  lineReader.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = message?.id != null ? pending.get(String(message.id)) : undefined;
    if (!waiter) {
      return;
    }
    pending.delete(String(message.id));
    if (message.error) {
      waiter.reject(new Error(String(message.error.message || JSON.stringify(message.error))));
    } else {
      waiter.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail.push(String(chunk));
    if (stderrTail.length > 20) {
      stderrTail.shift();
    }
  });
  child.on("error", (error) => rejectAll(new Error(`Codex executable '${requested}' failed to start: ${error.message}`)));
  child.on("exit", (code, signal) => {
    rejectAll(
      new Error(
        `codex app-server exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""} during model discovery.` +
          (stderrTail.length ? ` stderr: ${stderrTail.join("").trim().slice(-400)}` : ""),
      ),
    );
  });

  function rejectAll(error: Error): void {
    settledExit = settledExit || error;
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  }

  function request(method: string, params: unknown): Promise<any> {
    if (settledExit) {
      return Promise.reject(settledExit);
    }
    if (!child.stdin.writable) {
      return Promise.reject(new Error("codex app-server stdin is not writable."));
    }
    const id = `agentparty-models-${++seq}`;
    const promise = new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Codex model discovery timed out after ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([timeout, listModels(request, () => child.stdin.writable && child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`))]);
  } finally {
    lineReader.close();
    child.removeAllListeners("exit");
    child.kill();
  }
}

async function listModels(request: (method: string, params: unknown) => Promise<any>, notifyInitialized: () => unknown): Promise<CodexModelInfo[]> {
  await request("initialize", {
    clientInfo: { name: "agentparty", title: "AgentParty", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  notifyInitialized();

  const rawModels: unknown[] = [];
  let cursor: string | undefined;
  // Paginate defensively; the observed catalog is one page (nextCursor null).
  for (let page = 0; page < 10; page += 1) {
    const result = await request("model/list", cursor ? { cursor } : {});
    if (Array.isArray(result?.data)) {
      rawModels.push(...result.data);
    }
    cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) {
      break;
    }
  }

  const models = normalizeCodexModels(rawModels);
  if (models.length === 0) {
    throw new Error("codex app-server model/list returned no visible models.");
  }
  return models;
}
