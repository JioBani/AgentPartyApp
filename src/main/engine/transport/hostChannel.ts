import type { Writable } from "node:stream";
import { writeLine, type RpcHostResult } from "./rpc";

/**
 * The engine's outbound channel to the desktop that spawned it — the reverse
 * direction of {@link serveEngine}, sharing the same stdio pair.
 *
 * A headless engine inside a WSL distro is fully native for everything rooted in
 * the workspace (fs, git, the harness binary), but it is NOT on the host's
 * loopback. Work that must originate from the desktop is delegated here instead
 * of being reimplemented or reached over the network. See docs/WSL_REMOTE.md §7.
 *
 * Calls REJECT on timeout rather than hanging, because every caller so far sits
 * on a user-visible path: a wedged promise would stall message delivery with no
 * diagnostic, which is exactly the silent-failure mode this codebase forbids.
 */
export class HostChannel {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly output: Writable, private readonly timeoutMs = 60_000) {}

  /**
   * Routes a reply to its caller. Returns true when the message belonged to this
   * channel, so the RPC server can ignore what it does not own.
   */
  accept(message: unknown): boolean {
    const reply = message as RpcHostResult;
    if (!reply || reply.kind !== "callResult" || typeof reply.id !== "number") {
      return false;
    }
    const waiter = this.pending.get(reply.id);
    if (!waiter) {
      // A reply that arrives after its timeout — already settled, nothing to do.
      return true;
    }
    this.pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.ok) {
      waiter.resolve(reply.result);
    } else {
      waiter.reject(new Error(reply.error || "host call failed"));
    }
    return true;
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Host call '${method}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        writeLine(this.output, { kind: "call", id, method, args });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Engine host channel closed"));
    }
    this.pending.clear();
  }
}
