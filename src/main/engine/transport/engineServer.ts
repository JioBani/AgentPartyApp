import type { Readable, Writable } from "node:stream";
import type { EngineConnection } from "../engineConnection";
import { readLines, writeLine, type RpcRequest } from "./rpc";

/**
 * Serves one {@link EngineConnection} over a stream pair: reads RPC requests,
 * dispatches to the named engine method, and writes back the result (or error).
 * The engine may be synchronous (LocalEngine) — results are awaited uniformly,
 * so sync and async both work. See the WSL remote-engine design §7.
 */
export function serveEngine(
  engine: EngineConnection,
  input: Readable,
  output: Writable,
  /** Replies to engine→desktop calls share this stream; hand them back to their caller. */
  hostChannel?: { accept(message: unknown): boolean },
): () => void {
  return readLines(input, async (message: RpcRequest) => {
    if (hostChannel?.accept(message)) {
      return;
    }
    if (typeof message?.id !== "number" || typeof message?.method !== "string") {
      return;
    }
    const { id, method, args } = message;
    try {
      const fn = (engine as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        throw new Error(`Unknown engine method '${method}'`);
      }
      const result = await (fn as (...a: unknown[]) => unknown).apply(engine, Array.isArray(args) ? args : []);
      writeLine(output, { id, ok: true, result });
    } catch (error) {
      writeLine(output, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
