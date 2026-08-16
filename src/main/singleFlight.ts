/**
 * Collapses concurrent calls that share a key onto one in-flight attempt.
 *
 * Written for approval responses, where the second caller is not a retry but a
 * second PERSON — the user tapping twice, or answering from the phone while the
 * desktop card is still open. Letting both reach the harness means the first
 * delivers and the second is told `not_pending`, which surfaces as "too late"
 * for an answer that was in fact applied.
 *
 * Deliberately not a cache: the entry is dropped as soon as the attempt
 * settles, so a later call runs again and sees current state. It answers "is
 * this happening right now", not "did this ever happen" — that second question
 * belongs to whatever records the outcome.
 */
export class SingleFlight<T> {
  private readonly running = new Map<string, Promise<T>>();

  run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing) {
      return existing;
    }
    // Started before it is stored so a synchronous throw inside `start` cannot
    // leave a key pointing at nothing.
    const attempt = start().finally(() => { this.running.delete(key); });
    this.running.set(key, attempt);
    return attempt;
  }

  /** Whether an attempt for this key is in flight. Exposed for tests. */
  has(key: string): boolean {
    return this.running.has(key);
  }
}
