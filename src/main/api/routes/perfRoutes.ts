import type { MethodRoute } from "../methodRegistry";
import { flag, num, optText } from "../methodRegistry";

/**
 * Performance inspection of the RUNNING app.
 *
 * These are ordinary routes, not QA-only ones, on purpose: the whole reason
 * they exist is that a shipped app has to answer questions about a state that a
 * restart would destroy — and `/api/qa/*` is disabled in a shipped app.
 *
 * The surface is shaped for an agent reading it: one call for "what is it
 * holding now", a bounded start/stop pair for "what grew while I worked", and
 * an explicit capture for "V8, tell me what the app itself cannot".
 */
export const perfRoutes: MethodRoute[] = [
  {
    // Computed at call time. There is no sampler behind this — asking is the
    // only thing that makes it run.
    name: "perf.get",
    http: "GET /api/perf",
    handler: (p, ctx) => ctx.controller.getPerfSnapshot(ctx.workspace, {
      includeHarness: p.harness === undefined ? true : flag(p.harness),
      // `?deep=1` also asks each window's renderer for cumulative script/layout
      // timing through the DevTools protocol — a brief debugger attach, so it
      // is opt-in rather than part of every report.
      deep: flag(p.deep),
      // `?disk=1` also walks the party store: what a window will LOAD when it
      // opens a party, which is what makes a fresh window expensive.
      disk: flag(p.disk),
    }),
  },
  {
    name: "perf.record.start",
    http: "POST /api/perf/record/start",
    handler: (p, ctx) => ctx.controller.startPerfRecording(ctx.workspace, {
      intervalMs: num(p.intervalMs),
      maxSamples: num(p.maxSamples),
      maxMinutes: num(p.maxMinutes),
      includeHarness: p.includeHarness === undefined ? undefined : flag(p.includeHarness),
      toDisk: p.toDisk === undefined ? undefined : flag(p.toDisk),
    }),
  },
  {
    name: "perf.record.status",
    http: "GET /api/perf/record",
    handler: (_p, ctx) => ctx.controller.getPerfRecordingStatus(),
  },
  {
    // Returns the samples AND the growth summary, so the caller does not have
    // to diff the series itself to see what rose.
    name: "perf.record.stop",
    http: "POST /api/perf/record/stop",
    handler: (_p, ctx) => ctx.controller.stopPerfRecording(),
  },
  {
    // Writes a file and returns its path — never the contents. A heap snapshot
    // is ~100MB of conversation text; it stays on this machine.
    name: "perf.capture",
    http: "POST /api/perf/capture",
    remote: false,
    handler: (p, ctx) => ctx.controller.capturePerfArtifact({
      kind: optText(p.kind),
      target: optText(p.target),
      ms: num(p.ms),
    }),
  },
  {
    name: "perf.captures",
    http: "GET /api/perf/captures",
    remote: false,
    handler: (_p, ctx) => ctx.controller.listPerfCaptures(),
  },
];
