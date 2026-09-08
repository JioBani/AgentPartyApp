/**
 * What this window is holding, answered when the main process asks.
 *
 * The transcripts live HERE — a window keeps every open member's blocks, the
 * restored history it seeded them from, and each session's subagents — which is
 * why a renderer, not the main process, is what grows to gigabytes. A perf
 * report that could not see inside a window would only ever be able to say
 * "renderer: 1.2GB", which is the number that started the investigation, not
 * one that ends it.
 *
 * Main asks through `executeJavaScript`, so the entry point is a function on
 * `window`. That choice is deliberate: the timeout then lives entirely on the
 * asking side, and a window stuck in a long task simply fails to answer —
 * which is itself the finding — instead of hanging the report.
 *
 * Nothing here runs on a timer. The state is read through refs the app already
 * keeps, so registering a source costs a function reference.
 */

import { measureKeyed, type MemoryBucket } from "../../shared/perfMeasure";

const MB = 1024 * 1024;

/** A named piece of renderer state, read at measure time. */
type StateSource = () => Record<string, unknown> | Map<string, unknown>;

const sources = new Map<string, { read: StateSource; note?: string }>();

/**
 * Registers a state map under a name. Replacing rather than stacking, so a
 * remount cannot leave the previous closure behind holding the old state alive
 * — a memory tool that leaks memory would be worse than none.
 */
export function registerRendererState(name: string, read: StateSource, note?: string): void {
  sources.set(name, { read, note });
}

export interface RendererMemoryReport {
  buckets: MemoryBucket[];
  jsHeapUsedMb?: number;
  jsHeapLimitMb?: number;
  domNodes?: number;
}

export function collectRendererMemory(): RendererMemoryReport {
  const buckets: MemoryBucket[] = [];
  for (const [name, source] of sources) {
    try {
      buckets.push(measureKeyed(name, source.read(), { note: source.note, topCount: 5 }));
    } catch (error) {
      buckets.push({
        name,
        estimate: { chars: 0, approxBytes: 0, nodes: 0, items: 0, truncated: true },
        note: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  // Chromium-only, and absent when the page is cross-origin isolated in some
  // configurations — reported when present rather than depended on.
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return {
    buckets,
    jsHeapUsedMb: memory ? round(memory.usedJSHeapSize / MB) : undefined,
    jsHeapLimitMb: memory ? round(memory.jsHeapSizeLimit / MB) : undefined,
    // The DOM is the other half of a renderer's footprint: a transcript that is
    // 40MB of text can still be 200k nodes, and only one of those two numbers
    // is visible in the JS heap.
    domNodes: document.getElementsByTagName("*").length,
  };
}

/**
 * Publishes the entry point the main process calls. Idempotent, and safe to
 * call from a React effect — the window keeps exactly one.
 */
export function installRendererMemoryProbe(): void {
  (window as unknown as { __agentpartyPerf?: () => RendererMemoryReport }).__agentpartyPerf = collectRendererMemory;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
