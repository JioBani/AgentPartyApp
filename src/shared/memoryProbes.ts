/**
 * Who holds memory, asked at the moment someone wants to know.
 *
 * A probe is a function a holder registers for its OWN structures. Nothing
 * reaches across a boundary to measure someone else's map, and no holder has to
 * be wired into the controller just to be counted — the perf report asks the
 * registry, and whatever registered answers.
 *
 * Probes run ONLY when a report is requested. Registering one costs a function
 * reference; it does not sample, time, or accumulate anything.
 *
 * Used by both processes: the main process registers its caches here, and the
 * renderer registers the transcript state it keeps for the open windows.
 */

import type { MemoryBucket } from "./perfMeasure";

export type MemoryProbe = () => MemoryBucket | MemoryBucket[];

const probes = new Map<string, MemoryProbe>();

/**
 * Registers (or replaces) a probe under a name. Replacing rather than stacking
 * is deliberate: a holder that is rebuilt — a repository re-created on a
 * workspace switch — must not leave its predecessor's closure behind, which
 * would both double-count and pin the old object in memory. A perf tool that
 * leaks is worse than no perf tool.
 */
export function registerMemoryProbe(name: string, probe: MemoryProbe): void {
  probes.set(name, probe);
}

export function unregisterMemoryProbe(name: string): void {
  probes.delete(name);
}

/**
 * Runs every probe. A probe that throws is reported as a failed bucket rather
 * than taking the whole report down — a broken counter must not cost the reader
 * the numbers that still work, and silence would hide that one is missing.
 */
export function collectMemoryBuckets(): MemoryBucket[] {
  const buckets: MemoryBucket[] = [];
  for (const [name, probe] of probes) {
    try {
      const produced = probe();
      buckets.push(...(Array.isArray(produced) ? produced : [produced]));
    } catch (error) {
      buckets.push({
        name,
        estimate: { chars: 0, approxBytes: 0, nodes: 0, items: 0, truncated: true },
        note: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return buckets;
}

/** Names currently registered, so a report can say what it did NOT measure. */
export function registeredProbeNames(): string[] {
  return [...probes.keys()];
}
