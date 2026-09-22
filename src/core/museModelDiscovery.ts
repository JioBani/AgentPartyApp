import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveMuseCli } from "./museCli";
import { MUSE_BUNDLED_MODELS, normalizeMuseModels, type MuseModelDiscoveryState, type MuseModelInfo } from "../shared/museModels";

export interface MuseModelDiscoveryOptions {
  cwd: string;
  executablePath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Reads the authenticated Muse provider catalog without creating a session. */
export async function discoverMuseModels(options: MuseModelDiscoveryOptions): Promise<Omit<MuseModelDiscoveryState, "status" | "at">> {
  const cli = await resolveMuseCli(options.executablePath);
  const child = spawn(cli.command, ["serve", "--trust-workspace"], {
    cwd: options.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const stderr: string[] = [];
  let nextId = 1;
  let exited: Error | undefined;
  const reader = readline.createInterface({ input: child.stdout });

  const rejectAll = (error: Error) => {
    exited = exited || error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  reader.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line.replace(/\r$/, "")); } catch { return; }
    if (message?.id == null || message.method) return;
    const waiter = pending.get(Number(message.id));
    if (!waiter) return;
    pending.delete(Number(message.id));
    if (message.error) waiter.reject(new Error(String(message.error.message || JSON.stringify(message.error))));
    else waiter.resolve(message.result);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr.push(chunk);
    if (stderr.length > 20) stderr.shift();
  });
  child.once("error", (error) => rejectAll(error));
  child.once("exit", (code, signal) => rejectAll(new Error(
    `Muse Code MSP exited (${code ?? signal ?? "unknown"}) during model discovery.` +
      (stderr.length ? ` stderr: ${stderr.join("").trim().slice(-400)}` : ""),
  )));

  const request = (method: string, params: unknown): Promise<any> => {
    if (exited) return Promise.reject(exited);
    if (!child.stdin.writable) return Promise.reject(new Error("Muse Code MSP stdin is not writable."));
    const id = nextId++;
    const promise = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Muse model discovery timed out after ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([timeout, readCatalog(request, () => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    })]);
  } finally {
    reader.close();
    child.removeAllListeners("exit");
    child.kill();
  }
}

async function readCatalog(
  request: (method: string, params: unknown) => Promise<any>,
  initialized: () => void,
): Promise<{ models: MuseModelInfo[]; providerId?: string; profileId?: string; source?: string }> {
  await request("initialize", {
    clientInfo: { name: "agentparty", title: "AgentParty", version: "0.11.1" },
    capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: true },
  });
  initialized();
  const result = await request("model/list", {});
  const discovered = normalizeMuseModels(Array.isArray(result?.models) ? result.models : []);
  const models = discovered.length ? discovered : MUSE_BUNDLED_MODELS;
  return {
    models,
    providerId: typeof result.providerId === "string" ? result.providerId : undefined,
    profileId: typeof result.profileId === "string" ? result.profileId : undefined,
    source: discovered.length
      ? (typeof result.source === "string" ? result.source : "providerCatalog")
      : "agentpartyBundledCatalog",
  };
}
