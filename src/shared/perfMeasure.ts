/**
 * How big is this thing, measured cheaply enough to ask at request time.
 *
 * The point of the whole perf surface is attribution: "the renderer holds
 * 1.2GB" is not actionable, "this member's transcript holds 610MB of it" is.
 * Getting there without an always-on accounting ledger rests on one property of
 * JavaScript strings: `text.length` is a field read, NOT a scan. Summing the
 * lengths of every string in a 700MB transcript therefore costs one property
 * read per string — the work is proportional to the NUMBER of values, not to
 * the bytes they hold. A 50,000-block transcript measures in a few
 * milliseconds, which is why nothing has to be counted continuously.
 *
 * The number is an estimate, and named as one. It counts what the structure
 * REFERENCES: two maps holding the same block both report it, because
 * double-holding is exactly the kind of leak this is meant to expose. Real
 * unique retention is a heap snapshot's job (`perfCapture`), and the gap
 * between the two is the signal that the leak is not in our own data at all.
 */

export interface SizeEstimate {
  /** UTF-16 code units across every string reached. */
  chars: number;
  /** Upper bound on the bytes those strings occupy (V8 stores ASCII in one). */
  approxBytes: number;
  /** Values visited — the cost of the measurement itself, and a leak signal. */
  nodes: number;
  /** Arrays/Maps/Sets entries reached, for "how many blocks" style counts. */
  items: number;
  /** True when the walk hit its budget and the numbers are a floor, not a total. */
  truncated: boolean;
}

/**
 * A walk budget, so measuring can never become the performance problem it is
 * meant to find. Two million values is far more than any healthy state here
 * (a 50k-block transcript is ~500k values) and still returns in milliseconds.
 */
const DEFAULT_NODE_BUDGET = 2_000_000;

/** Per-value overhead charged for non-strings, so object-heavy state is not free. */
const VALUE_OVERHEAD_BYTES = 16;

export function emptyEstimate(): SizeEstimate {
  return { chars: 0, approxBytes: 0, nodes: 0, items: 0, truncated: false };
}

/**
 * Estimates the size of a value, iteratively (a recursive walk would blow the
 * stack on a long transcript) and with cycle protection.
 */
export function estimateSize(value: unknown, nodeBudget = DEFAULT_NODE_BUDGET): SizeEstimate {
  const result = emptyEstimate();
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (result.nodes >= nodeBudget) {
      result.truncated = true;
      break;
    }
    const current = stack.pop();
    result.nodes += 1;
    if (current === null || current === undefined) {
      continue;
    }
    const kind = typeof current;
    if (kind === "string") {
      result.chars += (current as string).length;
      // Two bytes per code unit is the ceiling: V8 keeps a latin1 string in one
      // byte per character, so an ASCII-heavy transcript really occupies about
      // half of this. Reported as a bound rather than guessed at.
      result.approxBytes += (current as string).length * 2;
      continue;
    }
    if (kind === "number" || kind === "boolean" || kind === "bigint") {
      result.approxBytes += 8;
      continue;
    }
    if (kind !== "object") {
      continue; // functions and symbols hold nothing we can attribute
    }
    const object = current as object;
    if (seen.has(object)) {
      continue;
    }
    seen.add(object);
    result.approxBytes += VALUE_OVERHEAD_BYTES;
    if (Array.isArray(object)) {
      result.items += object.length;
      for (const entry of object) {
        stack.push(entry);
      }
      continue;
    }
    if (object instanceof Map) {
      result.items += object.size;
      for (const [key, entry] of object) {
        stack.push(key);
        stack.push(entry);
      }
      continue;
    }
    if (object instanceof Set) {
      result.items += object.size;
      for (const entry of object) {
        stack.push(entry);
      }
      continue;
    }
    if (ArrayBuffer.isView(object)) {
      result.approxBytes += (object as ArrayBufferView).byteLength;
      continue;
    }
    for (const key of Object.keys(object)) {
      result.chars += key.length;
      result.approxBytes += key.length * 2;
      stack.push((object as Record<string, unknown>)[key]);
    }
  }
  return result;
}

/** Adds `b` into `a` — for totalling per-entry estimates without re-walking. */
export function addEstimate(a: SizeEstimate, b: SizeEstimate): SizeEstimate {
  return {
    chars: a.chars + b.chars,
    approxBytes: a.approxBytes + b.approxBytes,
    nodes: a.nodes + b.nodes,
    items: a.items + b.items,
    truncated: a.truncated || b.truncated,
  };
}

/** One named thing that holds memory, with the entries that make it up. */
export interface MemoryBucket {
  /** What holds it, e.g. `renderer.logsBySession`. */
  name: string;
  estimate: SizeEstimate;
  /**
   * The biggest contributors inside it, largest first — "which member", not
   * just "how much". Capped by the probe; the total above always covers all.
   */
  top?: Array<{ key: string; estimate: SizeEstimate }>;
  /** Entries in the container (sessions, members, cached files …). */
  entries?: number;
  /** Anything the reader needs to interpret the number. */
  note?: string;
}

/**
 * Measures a keyed container and reports its biggest entries.
 *
 * Shared because both processes hold the same SHAPE of state — a record keyed
 * by session or member whose values are block arrays — and the question asked
 * of it ("which key is the big one") is the same on both sides.
 */
export function measureKeyed(
  name: string,
  container: Record<string, unknown> | Map<string, unknown>,
  options: { topCount?: number; note?: string; nodeBudget?: number } = {},
): MemoryBucket {
  const pairs: Array<[string, unknown]> = container instanceof Map
    ? [...container.entries()]
    : Object.entries(container);
  const measured = pairs.map(([key, value]) => ({ key, estimate: estimateSize(value, options.nodeBudget) }));
  const total = measured.reduce((sum, entry) => addEstimate(sum, entry.estimate), emptyEstimate());
  const top = [...measured]
    .sort((a, b) => b.estimate.approxBytes - a.estimate.approxBytes)
    .slice(0, options.topCount ?? 5);
  return { name, estimate: total, top, entries: measured.length, note: options.note };
}
