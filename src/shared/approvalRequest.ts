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

/** Codex app-server server→client request → card fields. */
export function codexApprovalFields(method: string, params: any): ApprovalRequestFields {
  const meta = approvalMeta(method, params);
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
    title: options.title || options.displayName,
    description: options.description || options.decisionReason,
    suggestions: options.suggestions,
    blockedPath: options.blockedPath,
    agentID: options.agentID,
  };
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
