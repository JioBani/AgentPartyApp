/**
 * How much is FLOWING — the half of "why is it slow" that a size cannot answer.
 *
 * Memory attribution says what is held. It says nothing about an app that is
 * busy rather than swollen, and the last real slowdown here was exactly that:
 * an adapter emitted a snapshot per event, so the whole session list was
 * serialized and pushed to every window dozens of times a second. Nothing in a
 * size report would have shown it. A counter on the send path would have.
 *
 * These are monotonic totals, not rates and not histories: one integer per
 * name, incremented in place. A snapshot reports the totals and the rate since
 * the PREVIOUS snapshot, and a recording turns the same totals into a series by
 * differencing its samples — so the cost of keeping them is one addition on
 * paths that were already doing real work, and the cost of storing them never
 * grows.
 */

/**
 * Names are code-supplied, but a name built from data (a session id, a member)
 * would make this map grow without bound — the exact defect a perf tool must
 * not have. New names stop being accepted past the cap, and the overflow is
 * itself reported rather than silently dropped.
 */
const MAX_NAMES = 256;

const counters = new Map<string, number>();
let rejectedNames = 0;

export function countEvent(name: string, amount = 1): void {
  const current = counters.get(name);
  if (current !== undefined) {
    counters.set(name, current + amount);
    return;
  }
  if (counters.size >= MAX_NAMES) {
    rejectedNames += 1;
    return;
  }
  counters.set(name, amount);
}

export interface CounterReading {
  at: number;
  totals: Record<string, number>;
  /** Names refused because the table was full — a bug in a caller, made visible. */
  rejectedNames: number;
}

export function readCounters(): CounterReading {
  return { at: Date.now(), totals: Object.fromEntries(counters), rejectedNames };
}

/**
 * Per-second rates between two readings. Absent names count as zero, so a
 * counter that only appears in the newer reading still reports its rate.
 */
export function counterRates(previous: CounterReading | undefined, current: CounterReading): Record<string, number> {
  if (!previous || current.at <= previous.at) {
    return {};
  }
  const seconds = (current.at - previous.at) / 1000;
  const rates: Record<string, number> = {};
  for (const [name, total] of Object.entries(current.totals)) {
    const delta = total - (previous.totals[name] ?? 0);
    if (delta > 0) {
      rates[name] = Math.round((delta / seconds) * 10) / 10;
    }
  }
  return rates;
}
