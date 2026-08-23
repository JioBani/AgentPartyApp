import { mergeRendererSessions, updateRendererSessionSnapshot } from "../../src/renderer/app/sessionRenderState";
import { isTranscriptRestoreSettled, nextTranscriptRestore, nextTranscriptReveal, transcriptRestoreOrder } from "../../src/renderer/app/transcriptRestorePlan";
import { needsClip, previewOf, sameBlockProps } from "../../src/renderer/workbench/Transcript";
import { nextTranscriptMountLimit } from "../../src/renderer/workbench/transcriptScheduling";
import { createLatestMethodProxy } from "../../src/renderer/workbench/stableActions";

type Assert = (condition: boolean, message: string) => void;

export function run(assert: Assert): void {
  const baseSnapshot = {
    id: "harness-1", cwd: "C:/repo", model: "model", effort: "medium", status: "responding",
    harnessAlive: true, startedAt: "2026-01-01", debugMode: false, turnCount: 1, queuedTurnCount: 0,
    lastEventAt: "12:00:00",
  } as const;
  const current = [{ id: "session-1", title: "Model", workspace: "C:/repo", snapshot: baseSnapshot }];
  const clockOnly = [{ ...current[0], snapshot: { ...baseSnapshot, lastEventAt: "12:00:01" } }];
  assert(mergeRendererSessions(current, clockOnly) === current, "a token-only activity clock does not replace renderer session state");
  assert(updateRendererSessionSnapshot(current, "session-1", clockOnly[0].snapshot) === current, "the duplicate snapshot channel skips the same volatile update");
  const idle = [{ ...current[0], snapshot: { ...baseSnapshot, status: "idle" } }];
  assert(mergeRendererSessions(current, idle) !== current, "a visible session status change still reaches the renderer");

  const restoreMembers = ["main", "reviewer", "worker", "background"].map((name) => ({ name }));
  assert(
    transcriptRestoreOrder(restoreMembers, ["worker", "main"]).map((member) => member.name).join(",") === "worker,main,reviewer,background",
    "focused and visible transcripts restore before background tabs without losing persisted order",
  );
  assert(
    nextTranscriptRestore(restoreMembers, ["worker", "main"], () => false, (member) => member.name === "worker") === undefined,
    "a second transcript does not start while the current sequential restore is in flight",
  );
  assert(
    !isTranscriptRestoreSettled(true, true) && isTranscriptRestoreSettled(true, false),
    "a cached transcript refreshes in the background without treating its visible history as absent",
  );
  assert(
    nextTranscriptReveal(["worker", "main"], new Set(["worker"]), new Set(["worker", "main"])) === "main",
    "cached transcript DOM reveals one remaining visible panel at a time",
  );
  assert(
    [0, 0, 0, 0].reduce((current) => nextTranscriptMountLimit(current, 150), 20) === 150,
    "the progressive first paint converges exactly on the established 150-block history window",
  );

  let implementation = { call: (value: string) => `old:${value}` };
  const proxy = createLatestMethodProxy(() => implementation);
  const stableCall = proxy.call;
  implementation = { call: (value: string) => `new:${value}` };
  assert(proxy.call === stableCall, "action delegate identity stays stable across app renders");
  assert(proxy.call("value") === "new:value", "a stable action delegates to the latest React closure");

  const block = { id: "a1", kind: "assistant", text: "old", at: "12:00" } as const;
  const transcript = [block];
  const view = {
    name: "main", model: "model", member: { runtime: "codex" }, transcript,
  } as any;
  const previous = { block, view, density: "wide", detail: "full", actions: { old: true }, live: false } as any;
  const rebuiltView = { ...view };
  assert(sameBlockProps(previous, { ...previous, view: rebuiltView, actions: { next: true } }), "an unchanged historical assistant block is reused across a rebuilt member view");
  assert(!sameBlockProps(previous, { ...previous, block: { ...block, text: "streamed" } }), "the one assistant block receiving a delta still rerenders");
  assert(!sameBlockProps(previous, { ...previous, live: true }), "a completed assistant block rerenders when it becomes live or committed");

  const environment = { id: "e1", kind: "environment", checkId: "cli", text: "missing" } as const;
  const environmentProps = { ...previous, block: environment, view, actions: stableCall } as any;
  assert(!sameBlockProps(environmentProps, { ...environmentProps, view: { ...view, transcript: [...transcript, { id: "u1", kind: "user", text: "retry" }] } }), "environment retry cards refresh when the latest user turn changes");

  const previews = [
    "", "short", "x".repeat(320), "x".repeat(321),
    "1\n2\n3\n4\n5\n6", "1\n2\n3\n4\n5\n6\n7",
    `${"x".repeat(200)}\n${"y".repeat(200)}`,
  ];
  for (const text of previews) {
    const legacyNeedsClip = Boolean(text) && (text.length > 320 || text.split("\n").length > 6);
    const legacyPreview = legacyNeedsClip
      ? `${text.split("\n").slice(0, 6).join("\n").slice(0, 320).replace(/\s+$/, "")} …`
      : text;
    assert(needsClip(text) === legacyNeedsClip && previewOf(text) === legacyPreview, `bounded preview matches legacy output (${text.length} chars)`);
  }
}
