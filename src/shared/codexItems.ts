/**
 * Codex ThreadItem → transcript rendering model (Item 3). Pure, testable helpers
 * that normalize the app-server's typed items (plan / commandExecution /
 * fileChange / mcpToolCall …) into the shapes the UI renders. Field names are
 * verified against `codex app-server generate-ts` (ThreadItem, FileUpdateChange,
 * TurnPlanStep, PatchChangeKind).
 */

export type CodexPlanStatus = "pending" | "inProgress" | "completed";

export interface CodexPlanStep {
  step: string;
  status: CodexPlanStatus | string;
}

export interface CodexFileEdit {
  path: string;
  /** "add" | "delete" | "update" (rename carries a move path we fold into the label). */
  kind: string;
  added: number;
  removed: number;
  diff?: string;
}

/** Counts added/removed lines in a unified diff (ignores +++/--- headers). */
export function diffStats(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!diff) {
    return { added, removed };
  }
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

/** Normalizes a fileChange item's `changes` (FileUpdateChange[]) into edits with +/- stats. */
export function fileEditsFrom(changes: any): CodexFileEdit[] {
  if (!Array.isArray(changes)) {
    return [];
  }
  return changes
    .map((change) => {
      const path = String(change?.path ?? "");
      const diff = typeof change?.diff === "string" ? change.diff : undefined;
      const stats = diffStats(diff);
      return { path, kind: patchKindLabel(change?.kind), added: stats.added, removed: stats.removed, diff };
    })
    .filter((edit) => edit.path);
}

/** PatchChangeKind ({type:"add"|"delete"|"update", move_path?}) → a short label. */
export function patchKindLabel(kind: any): string {
  const type = typeof kind === "string" ? kind : String(kind?.type ?? "update");
  if (type === "update" && kind?.move_path) {
    return "rename";
  }
  return type;
}

/** Normalizes TurnPlanStep[] (from turn/plan/updated) into plan steps. */
export function planStepsFrom(plan: any): CodexPlanStep[] {
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan
    .map((entry) => ({ step: String(entry?.step ?? ""), status: String(entry?.status ?? "pending") }))
    .filter((entry) => entry.step);
}

/** Provenance badge for a tool item: mcp:<server> / plugin:<id> / <namespace>. */
export function toolSourceLabel(item: any): string {
  if (item?.type === "mcpToolCall") {
    return item?.pluginId ? `plugin:${item.pluginId}` : `mcp:${item?.server ?? "?"}`;
  }
  if (item?.type === "dynamicToolCall") {
    return item?.namespace ? String(item.namespace) : "tool";
  }
  if (item?.type === "commandExecution") {
    return "shell";
  }
  if (item?.type === "webSearch") {
    return "web";
  }
  return "";
}
