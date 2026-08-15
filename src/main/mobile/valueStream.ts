import type { ValueStream } from "../../shared/mobileProtocol";

/**
 * Writable side of {@link ValueStream}. Kept internal to the mobile pipe: the
 * gateway hands consumers the read-only `ValueStream` view so nobody outside
 * `src/main/mobile/` can publish a status the pipe did not observe.
 */
export class MutableValueStream<T> implements ValueStream<T> {
  private value: T;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get current(): T {
    return this.value;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Publishes `next` to every subscriber. A throwing listener is reported and
   * skipped rather than aborting the remaining fan-out — one bad renderer
   * bridge must not stall the pipe (AGENTS.md: no silent failure, no coupling).
   */
  set(next: T, onListenerError?: (error: unknown) => void): void {
    this.value = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        onListenerError?.(error);
      }
    }
  }

  /** Convenience for object-shaped state: publishes `{...current, ...patch}`. */
  patch(patch: Partial<T>, onListenerError?: (error: unknown) => void): void {
    this.set({ ...this.value, ...patch }, onListenerError);
  }

  /** Read-only view handed to consumers. */
  readable(): ValueStream<T> {
    return this;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
