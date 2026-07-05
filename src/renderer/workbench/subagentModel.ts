import type { PanelDensity, Subagent } from "./types";
import type { SubagentBlock, SubagentPhase } from "../../shared/subagentActivity";
import { subagentActionLabel } from "../../shared/subagentActivity";
import { hexA } from "../theme/memberColors";

/**
 * Pure view-model derivation for the subagent dock + detail — the port of the
 * design prototype's `subDock` / `subDetail` logic. Keeping it here (not in the
 * components) makes the status→color mapping, responsive thresholds, and the
 * currentAction selection unit-testable and one-place-to-change.
 */

interface StatusStyle {
  label: string;
  /** dot / text color. */
  color: string;
  /** pill background. */
  bg: string;
  working: boolean;
}

/**
 * status → label · color · pill background. `working` uses the owning member's
 * color (with a pulse ring in the view); done/failed/queued use fixed tokens.
 */
export function subagentStatusStyle(phase: SubagentPhase, memberColor: string): StatusStyle {
  switch (phase) {
    case "working":
      return { label: "실행 중", color: memberColor, bg: hexA(memberColor, 0.15), working: true };
    case "done":
      return { label: "완료", color: "var(--success)", bg: "var(--success-dim)", working: false };
    case "failed":
      return { label: "실패", color: "var(--danger)", bg: "var(--danger-dim)", working: false };
    default:
      return { label: "대기", color: "var(--text-3)", bg: "var(--bg-3)", working: false };
  }
}

export interface SubDockDot {
  color: string;
  working: boolean;
}

export interface SubDockRow {
  id: string;
  name: string;
  hint?: string;
  /** Middle line: the live activity when working, else the delegated task. */
  line: string;
  showLine: boolean;
  showMeta: boolean;
  meta: string;
  dotColor: string;
  working: boolean;
  statusLabel: string;
  statusColor: string;
  statusBg: string;
  rowActive: boolean;
}

export interface SubDockView {
  count: number;
  running: number;
  expanded: boolean;
  summary: string;
  dots: SubDockDot[];
  rows: SubDockRow[];
}

/**
 * Builds the dock view-model. `summary` joins non-zero status counts
 * ("2 실행 · 2 완료 · 2 대기"); the row `line` prefers the live activity while a
 * subagent is working so the dock answers "what is it doing right now?".
 */
export function buildSubDock(
  subagents: Subagent[],
  memberColor: string,
  density: PanelDensity,
  openId: string | undefined,
  collapsed: boolean,
): SubDockView {
  const running = subagents.filter((s) => s.phase === "working").length;
  const done = subagents.filter((s) => s.phase === "done").length;
  const queued = subagents.filter((s) => s.phase === "queued").length;
  const failed = subagents.filter((s) => s.phase === "failed").length;
  const summary = [
    running ? `${running} 실행` : null,
    done ? `${done} 완료` : null,
    failed ? `${failed} 실패` : null,
    queued ? `${queued} 대기` : null,
  ].filter(Boolean).join(" · ");

  return {
    count: subagents.length,
    running,
    expanded: !collapsed,
    summary,
    dots: subagents.map((s) => {
      const style = subagentStatusStyle(s.phase, memberColor);
      return { color: style.color, working: style.working };
    }),
    rows: subagents.map((s) => {
      const style = subagentStatusStyle(s.phase, memberColor);
      const activity = s.phase === "working" ? subagentActionLabel(s.activity) : "";
      return {
        id: s.id,
        name: s.name,
        hint: s.hint,
        line: activity || s.task || "",
        showLine: density !== "narrow",
        showMeta: density === "wide",
        meta: [s.tools, s.dur].filter(Boolean).join(" · "),
        dotColor: style.color,
        working: style.working,
        statusLabel: style.label,
        statusColor: style.color,
        statusBg: style.bg,
        rowActive: openId === s.id,
      };
    }),
  };
}

export interface SubDetailBlockView {
  kind: SubagentBlock["kind"];
  text: string;
  toolName: string;
  arg: string;
  result: string;
  durationMs?: number;
}

export interface SubDetailView {
  id: string;
  name: string;
  hint?: string;
  task: string;
  statusLabel: string;
  statusColor: string;
  statusBg: string;
  working: boolean;
  blocks: SubDetailBlockView[];
}

/** Builds the drill-in detail view-model for the open subagent (or null). */
export function buildSubDetail(subagent: Subagent | undefined, memberColor: string): SubDetailView | null {
  if (!subagent) {
    return null;
  }
  const style = subagentStatusStyle(subagent.phase, memberColor);
  return {
    id: subagent.id,
    name: subagent.name,
    hint: subagent.hint,
    task: subagent.task || "",
    statusLabel: style.label,
    statusColor: style.color,
    statusBg: style.bg,
    working: style.working,
    // Drop assistant/status blocks that carry no text — a harness can complete a
    // message item with empty body, which would otherwise render as a blank line
    // ("선처럼" dead strips) in the transcript. Tool blocks always stay (their
    // identity is the tool card itself, even without a result body).
    blocks: subagent.blocks
      .filter((b) => (b.kind === "assistant" || b.kind === "status" ? Boolean(b.text && b.text.trim()) : true))
      .map((b) => ({
        kind: b.kind,
        text: b.kind === "assistant" || b.kind === "status" ? b.text : "",
        toolName: b.kind === "tool" ? b.name : "",
        arg: b.kind === "tool" ? (b.arg || "") : "",
        result: b.kind === "tool" ? (b.result || "") : "",
        durationMs: b.kind === "tool" ? b.durationMs : undefined,
      })),
  };
}

/** Formats a tool duration (ms) as the dock/detail expects (e.g. "40 ms", "2.0s"). */
export function formatSubDuration(durationMs: number | undefined): string {
  if (typeof durationMs !== "number") {
    return "";
  }
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs} ms`;
}
