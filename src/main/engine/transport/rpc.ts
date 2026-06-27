import type { Readable, Writable } from "node:stream";

/**
 * Minimal request/response RPC framed as newline-delimited JSON over a pair of
 * streams. Used so the desktop client can drive an engine running in another
 * host (a WSL distro) over the child process's stdio — deterministic, no ports,
 * and it crosses the `wsl.exe` boundary unchanged. See docs/WSL_REMOTE.md §7.
 *
 * JSON.stringify escapes newlines, so a single `\n` is a safe frame delimiter.
 */
export interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Writes one JSON value as a single `\n`-terminated line. */
export function writeLine(stream: Writable, value: RpcRequest | RpcResponse): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

/**
 * Reads `\n`-delimited JSON lines from a stream, buffering partial chunks.
 * Returns a disposer that detaches the listener.
 */
export function readLines(stream: Readable, onValue: (value: any) => void): () => void {
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const trimmed = line.trim();
      if (trimmed) {
        try {
          onValue(JSON.parse(trimmed));
        } catch {
          // Ignore non-JSON noise on the channel.
        }
      }
      index = buffer.indexOf("\n");
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}
