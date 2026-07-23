export const CURSOR_AGENT_MODES = ["agent", "ask", "plan"] as const;
export type CursorAgentMode = (typeof CURSOR_AGENT_MODES)[number];

export const CURSOR_APPROVAL_MODES = ["allowlist", "auto-review", "unrestricted"] as const;
export type CursorApprovalMode = (typeof CURSOR_APPROVAL_MODES)[number];

/** Cursor's independent work-mode and tool-approval controls. */
export interface CursorPolicy {
  mode: CursorAgentMode;
  approval: CursorApprovalMode;
}

export const DEFAULT_CURSOR_POLICY: CursorPolicy = {
  mode: "agent",
  approval: "allowlist",
};

export function isCursorAgentMode(value: unknown): value is CursorAgentMode {
  return typeof value === "string" && (CURSOR_AGENT_MODES as readonly string[]).includes(value);
}

export function isCursorApprovalMode(value: unknown): value is CursorApprovalMode {
  return typeof value === "string" && (CURSOR_APPROVAL_MODES as readonly string[]).includes(value);
}

export function requireCursorPolicy(value: unknown): CursorPolicy {
  if (!value || typeof value !== "object") {
    throw new Error("Cursor permission requires both mode and approval.");
  }
  const candidate = value as Partial<CursorPolicy>;
  if (!isCursorAgentMode(candidate.mode)) {
    throw new Error(`Unknown Cursor agent mode '${String(candidate.mode)}'.`);
  }
  if (!isCursorApprovalMode(candidate.approval)) {
    throw new Error(`Unknown Cursor approval mode '${String(candidate.approval)}'.`);
  }
  return { mode: candidate.mode, approval: candidate.approval };
}

/** Preserves the effective CLI flags of pre-Cursor-policy saved members. */
export function cursorPolicyFromLegacyPermission(mode: string | undefined): CursorPolicy {
  if (mode === "plan") return { mode: "plan", approval: "allowlist" };
  if (mode === "auto" || mode === "dontAsk") return { mode: "agent", approval: "auto-review" };
  if (mode === "acceptEdits" || mode === "bypassPermissions") return { mode: "agent", approval: "unrestricted" };
  return { ...DEFAULT_CURSOR_POLICY };
}

export function cursorPolicyOf(policy: unknown, legacyPermission?: string): CursorPolicy {
  return policy && typeof policy === "object"
    ? requireCursorPolicy(policy)
    : cursorPolicyFromLegacyPermission(legacyPermission);
}
