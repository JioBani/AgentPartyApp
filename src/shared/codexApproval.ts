/**
 * Codex approval decisions — the "정확히 보고 고르는" approval card model (Item 2).
 *
 * Codex approvals are richer than Claude's allow/deny: a command can be approved
 * once, for the whole session, or turned into a permanent prefix rule (execpolicy
 * amendment). This module is the single, testable source for the user-facing
 * decision set and how each maps to the app-server protocol values (verified
 * against `codex app-server generate-ts`: ReviewDecision,
 * CommandExecutionApprovalDecision, FileChangeApprovalDecision).
 */

/** User-facing decision on a Codex approval request. */
export type CodexDecision = "once" | "session" | "always" | "decline";

export type CodexApprovalKind =
  | "command" // item/commandExecution/requestApproval, execCommandApproval
  | "fileChange" // item/fileChange/requestApproval, applyPatchApproval
  | "permissions" // item/permissions/requestApproval (network/path elevation)
  | "userInput" // item/tool/requestUserInput (tool asks for a value)
  | "elicitation" // mcpServer/elicitation/request
  | "generic";

/** Display metadata carried on an approval_request so the card renders exactly. */
export interface CodexApprovalMeta {
  kind: CodexApprovalKind;
  /** Command to run (command approvals). */
  command?: string;
  /** Working directory the command/patch runs in. */
  cwd?: string;
  /** Why Codex is asking (e.g. "needs network access"). */
  reason?: string;
  /** Unified diff for file-change approvals, when available. */
  diff?: string;
  /** True when the request offers a prefix rule (execpolicy amendment) → enables "always". */
  canAlways?: boolean;
  /** The command pattern that "always" would auto-approve, for the button hint. */
  alwaysHint?: string;
  /** MCP server name (elicitation). */
  serverName?: string;
}

export const CODEX_DECISION_LABELS: Record<CodexDecision, string> = {
  once: "이번만 허용",
  session: "이 세션 동안",
  always: "항상 허용 (규칙)",
  decline: "거부",
};

export const CODEX_DECISION_HINTS: Record<CodexDecision, string> = {
  once: "이 요청만 승인합니다.",
  session: "이 세션이 끝날 때까지 같은 요청을 다시 묻지 않습니다.",
  always: "같은 명령 패턴을 규칙으로 저장해 앞으로 자동 승인합니다.",
  decline: "이 요청을 거부합니다.",
};

/**
 * Which decision buttons a card should offer, in display order (safest last so
 * the primary/rightmost button is the least destructive-to-safety choice — the
 * card decides emphasis). "always" only when the request advertises a rule.
 */
export function codexApprovalOptions(meta: CodexApprovalMeta | undefined): CodexDecision[] {
  if (!meta) {
    return ["decline", "once"];
  }
  switch (meta.kind) {
    case "command":
      return meta.canAlways ? ["decline", "once", "session", "always"] : ["decline", "once", "session"];
    case "fileChange":
    case "permissions":
    case "elicitation":
      return ["decline", "once", "session"];
    default:
      return ["decline", "once"];
  }
}

/** Resolve the decision from the coarse allow/deny plus an explicit override. */
export function codexDecisionOf(behavior: "allow" | "deny" | undefined, updatedInput: unknown): CodexDecision {
  const explicit = (updatedInput as { codexDecision?: CodexDecision } | undefined)?.codexDecision;
  if (explicit === "once" || explicit === "session" || explicit === "always" || explicit === "decline") {
    return explicit;
  }
  return behavior === "allow" ? "once" : "decline";
}

// ---- protocol mappers -------------------------------------------------------

/** CommandExecutionApprovalDecision. `amendment` = proposedExecpolicyAmendment. */
export function commandExecutionDecision(decision: CodexDecision, amendment?: string[]): unknown {
  switch (decision) {
    case "once":
      return "accept";
    case "session":
      return "acceptForSession";
    case "always":
      return amendment && amendment.length
        ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }
        : "acceptForSession"; // no rule offered → session is the closest honorable choice
    case "decline":
      return "decline";
  }
}

/** FileChangeApprovalDecision — no prefix rule; "always" degrades to session. */
export function fileChangeDecision(decision: CodexDecision): "accept" | "acceptForSession" | "decline" {
  switch (decision) {
    case "once":
      return "accept";
    case "session":
    case "always":
      return "acceptForSession";
    case "decline":
      return "decline";
  }
}

/** Legacy ReviewDecision for execCommandApproval / applyPatchApproval. */
export function reviewDecision(decision: CodexDecision, amendment?: string[]): unknown {
  switch (decision) {
    case "once":
      return "approved";
    case "session":
      return "approved_for_session";
    case "always":
      return amendment && amendment.length
        ? { approved_execpolicy_amendment: { proposed_execpolicy_amendment: amendment } }
        : "approved_for_session";
    case "decline":
      return "denied";
  }
}

/** MCP elicitation action. */
export function elicitationAction(decision: CodexDecision): "accept" | "decline" | "cancel" {
  return decision === "decline" ? "decline" : "accept";
}

// ---- request → card metadata / response (protocol translation) --------------

/** Classifies a server approval/input request method into a display kind. */
export function approvalKindOf(method: string): CodexApprovalKind {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return "command";
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return "fileChange";
  }
  if (method === "item/permissions/requestApproval") {
    return "permissions";
  }
  if (method === "item/tool/requestUserInput") {
    return "userInput";
  }
  if (method === "mcpServer/elicitation/request") {
    return "elicitation";
  }
  return "generic";
}

/** Builds the card metadata (command/diff/reason/rule) from raw request params. */
export function approvalMeta(method: string, params: any): CodexApprovalMeta {
  const kind = approvalKindOf(method);
  const amendment: string[] | undefined = Array.isArray(params?.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : undefined;
  return {
    kind,
    command: typeof params?.command === "string" ? params.command : undefined,
    cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
    reason: typeof params?.reason === "string" ? params.reason : undefined,
    diff: typeof params?.unifiedDiff === "string" ? params.unifiedDiff : typeof params?.diff === "string" ? params.diff : undefined,
    canAlways: kind === "command" && Boolean(amendment && amendment.length),
    alwaysHint: amendment && amendment.length ? amendment.join(" ") : undefined,
    serverName: typeof params?.serverName === "string" ? params.serverName : undefined,
  };
}

/** Normalizes ToolRequestUserInputQuestion[] into the AskUserQuestion card shape. */
export function normalizeUserInputQuestions(questions: any): unknown[] {
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.map((q) => ({
    id: String(q?.id ?? ""),
    header: q?.header ? String(q.header) : undefined,
    question: String(q?.question ?? q?.header ?? ""),
    multiSelect: false,
    secret: Boolean(q?.isSecret),
    options: Array.isArray(q?.options)
      ? q.options.map((o: any) => ({ label: String(o?.label ?? ""), description: o?.description ? String(o.description) : undefined })).filter((o: any) => o.label)
      : [],
  }));
}

/** Assembles the protocol `result` for a resolved request from the user's decision. */
export function approvalResult(method: string, decision: CodexDecision, params: Record<string, any>, updatedInput: unknown): unknown {
  const kind = approvalKindOf(method);
  const amendment: string[] | undefined = Array.isArray(params?.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : undefined;
  switch (kind) {
    case "command":
      return method === "execCommandApproval"
        ? { decision: reviewDecision(decision, amendment) }
        : { decision: commandExecutionDecision(decision, amendment) };
    case "fileChange":
      return method === "applyPatchApproval"
        ? { decision: reviewDecision(decision, amendment) }
        : { decision: fileChangeDecision(decision) };
    case "permissions": {
      // Echo the requested profile back as granted (accept) or empty (decline).
      const granted = decision === "decline" ? {} : { network: params?.permissions?.network ?? undefined, fileSystem: params?.permissions?.fileSystem ?? undefined };
      return { permissions: granted, scope: decision === "session" ? "session" : "turn" };
    }
    case "userInput":
      return { answers: mapUserInputAnswers(params?.questions, (updatedInput as { answers?: Record<string, string> } | undefined)?.answers) };
    case "elicitation":
      return { action: elicitationAction(decision), content: null, _meta: null };
    default:
      return { decision: decision === "decline" ? "decline" : "accept" };
  }
}

/** Maps card answers (keyed by question text) back to the protocol's id-keyed shape. */
export function mapUserInputAnswers(questions: any, answers: Record<string, string> | undefined): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {};
  if (!Array.isArray(questions) || !answers) {
    return out;
  }
  for (const q of questions) {
    const id = String(q?.id ?? "");
    const key = String(q?.question ?? q?.header ?? "");
    const raw = answers[key];
    if (id && typeof raw === "string") {
      out[id] = { answers: raw.split(",").map((item) => item.trim()).filter(Boolean) };
    }
  }
  return out;
}
