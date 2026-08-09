/**
 * Harness request → approval card fields, in ONE place.
 *
 * Both adapters used to build the `approval_request` event inline. That made the
 * QA mock a second, hand-written copy of the mapping — which is exactly how the
 * card came to be verified against values no harness ever sends (B-18). The mock
 * now calls these same functions, so an injected card and a live one cannot
 * drift apart: if this mapping is wrong, both are wrong together and QA sees it.
 *
 * What each harness actually sends is recorded in scripts/fixtures/approvals/
 * and replayed by scripts/qa-approval-shapes.mjs.
 */

import { approvalMeta, approvalKindOf, normalizeUserInputQuestions } from "./codexApproval";
import type { CodexApprovalKind, CodexApprovalMeta } from "./codexApproval";
import type { CodexFileEdit } from "./codexItems";

/** The card-facing part of an `approval_request` event (adapters add id + time). */
export interface ApprovalRequestFields {
  toolName: string;
  input: unknown;
  title?: string;
  description?: string;
  suggestions?: unknown[];
  /** Path that triggered the request (Claude Code; e.g. a write outside cwd). */
  blockedPath?: string;
  /** Subagent that raised it, when it did not come from the main loop. */
  agentID?: string;
  codex?: CodexApprovalMeta;
}

export function approvalTitle(kind: CodexApprovalKind): string {
  switch (kind) {
    case "command":
      return "명령 실행 승인";
    case "fileChange":
      return "파일 변경 승인";
    case "permissions":
      return "권한 상승 승인";
    case "userInput":
      return "Codex가 입력을 요청함";
    case "elicitation":
      return "MCP 서버 요청";
    default:
      return "승인 요청";
  }
}

/**
 * Codex app-server server→client request → card fields.
 *
 * `edits` come from the `fileChange` item this approval names in `itemId`. A
 * file-change approval carries no diff of its own — measured, its params are
 * threadId/turnId/itemId/startedAtMs plus a null reason and grantRoot — so
 * without them the card can only say "파일 변경 승인" and offer three buttons,
 * asking the user to approve an edit they cannot see.
 */
export function codexApprovalFields(method: string, params: any, edits?: CodexFileEdit[]): ApprovalRequestFields {
  const meta = approvalMeta(method, params, edits);
  // A tool asking for a value reuses the interactive question card; its answers
  // are shaped like AskUserQuestion so the renderer can drive it.
  const input = meta.kind === "userInput" ? { questions: normalizeUserInputQuestions(params?.questions) } : params;
  return {
    toolName: method,
    input,
    title: approvalTitle(approvalKindOf(method)),
    description: meta.reason,
    codex: meta,
  };
}

/**
 * Claude Code SDK `canUseTool` arguments → card fields.
 *
 * `blockedPath` and `agentID` are carried through deliberately: both arrive
 * populated from the real SDK (measured — a Bash write reports the exact
 * offending path) and used to stop at the adapter, so the card could never show
 * which path caused the prompt or which subagent asked.
 */
export function claudeApprovalFields(
  toolName: string,
  input: unknown,
  options: {
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    agentID?: string;
  },
): ApprovalRequestFields {
  return {
    toolName,
    input: withFilePath(input),
    // The heading names the TYPE of approval, not the tool — the tool already
    // has its own chip beside it, and "Bash" twice tells the user nothing about
    // what they are being asked to allow. The SDK's own prompt sentence wins
    // when it sends one (measured: it usually does not).
    title: options.title || claudeApprovalTitle(toolName),
    description: options.description || options.decisionReason,
    suggestions: options.suggestions,
    blockedPath: options.blockedPath,
    agentID: options.agentID,
  };
}

/** Claude has no approval "kind" of its own, so the tool decides the heading. */
export function claudeApprovalTitle(toolName: string): string {
  if (/^(Bash|BashOutput|KillShell)$/.test(toolName)) {
    return approvalTitle("command");
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
    return approvalTitle("fileChange");
  }
  return approvalTitle("generic");
}

/**
 * What Claude Code's "always allow" would actually agree to.
 *
 * The SDK hands the caller a ready-made set of `PermissionUpdate`s in
 * `suggestions` and expects them back as `updatedPermissions` when the user
 * picks "always allow" — measured, a Bash write offers
 * `{addRules, rules:[{toolName:"Bash", ruleContent:"echo one *"}],
 *   behavior:"allow", destination:"localSettings"}`, i.e. a real prefix rule
 * that is written to disk rather than kept for the session.
 *
 * `hint` is that rule in words, so the card can state what is being agreed to
 * instead of offering a blank promise. Returns undefined when the request
 * carries no rule, which is how the card knows not to offer the choice.
 */
export function claudeAlwaysRule(suggestions: unknown): { hint: string; scope: string } | undefined {
  if (!Array.isArray(suggestions)) {
    return undefined;
  }
  for (const suggestion of suggestions) {
    const update = asRecord(suggestion);
    if (!update) {
      continue;
    }
    if (update.type === "addRules" && Array.isArray(update.rules)) {
      const rules = update.rules
        .map((rule) => asRecord(rule))
        .map((rule) => (typeof rule?.ruleContent === "string" && rule.ruleContent ? rule.ruleContent : typeof rule?.toolName === "string" ? rule.toolName : ""))
        .filter(Boolean);
      if (rules.length) {
        return { hint: rules.join(", "), scope: String(update.destination || "") };
      }
    }
    if (update.type === "addDirectories" && Array.isArray(update.directories) && update.directories.length) {
      return { hint: update.directories.filter((d) => typeof d === "string").join(", "), scope: String(update.destination || "") };
    }
    if (update.type === "setMode" && typeof update.mode === "string") {
      return { hint: `${update.mode} 모드`, scope: String(update.destination || "") };
    }
  }
  return undefined;
}

/** Adds a normalized `filePath` so the card can name the file for any tool. */
export function withFilePath(value: unknown): unknown {
  const record = asRecord(value);
  if (!record || record.filePath) {
    return value;
  }
  const filePath = extractToolFilePath(record);
  if (typeof filePath !== "string" || !filePath) {
    return value;
  }
  return { ...record, filePath };
}

export function extractToolFilePath(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ["filePath", "file_path", "path", "notebook_path", "filename"]) {
    const field = record[key];
    if (typeof field === "string" && field) {
      return field;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
