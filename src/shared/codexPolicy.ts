/**
 * Codex safety model — two orthogonal axes, surfaced to the user as three
 * presets (Read Only / Auto / Full Access) plus an independent guardian toggle.
 * See docs/codex-ux-research/02-approvals-sandbox-permissions.md.
 *
 * - sandbox mode  = what Codex *can technically touch*.
 * - approval policy = *when Codex stops to ask*.
 *
 * A Claude member has a single permission mode; a Codex member uses this model.
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface CodexPolicy {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  /** approvals_reviewer = "auto_review": route approvals through a reviewer. */
  guardian: boolean;
}

export type CodexPreset = "read-only" | "auto" | "full-access" | "custom";

/** The three user-facing presets (guardian is orthogonal, not part of a preset). */
export const CODEX_PRESETS: Record<Exclude<CodexPreset, "custom">, Omit<CodexPolicy, "guardian">> = {
  "read-only": { sandbox: "read-only", approval: "on-request" },
  auto: { sandbox: "workspace-write", approval: "on-request" },
  "full-access": { sandbox: "danger-full-access", approval: "never" },
};

/**
 * Includes `custom`, which is NOT selectable — there is no combination to apply
 * — but is a state the UI must be able to name, so the preset strip can say
 * "these axes match no preset" instead of rendering with nothing highlighted.
 */
export const CODEX_PRESET_LABELS: Record<CodexPreset, string> = {
  "read-only": "Read Only",
  auto: "Auto",
  "full-access": "Full Access",
  custom: "Custom",
};

export const DEFAULT_CODEX_POLICY: CodexPolicy = { sandbox: "workspace-write", approval: "on-request", guardian: false };

export const CODEX_SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
export const CODEX_APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["untrusted", "on-request", "never"];

/** Closed validation gate for values crossing HTTP/MCP/IPC boundaries. */
export function isCodexPolicy(value: unknown): value is CodexPolicy {
  if (!value || typeof value !== "object") {
    return false;
  }
  const policy = value as Partial<CodexPolicy>;
  return CODEX_SANDBOX_MODES.includes(policy.sandbox as SandboxMode)
    && CODEX_APPROVAL_POLICIES.includes(policy.approval as ApprovalPolicy)
    && typeof policy.guardian === "boolean";
}

/** Returns a detached, validated policy or throws a user-visible contract error. */
export function requireCodexPolicy(value: unknown): CodexPolicy {
  if (!isCodexPolicy(value)) {
    throw new Error("Codex policy requires sandbox, approval, and boolean guardian fields.");
  }
  return { sandbox: value.sandbox, approval: value.approval, guardian: value.guardian };
}

/** Which preset (if any) a policy matches — "custom" when the axes don't line up. */
export function codexPresetOf(policy: Pick<CodexPolicy, "sandbox" | "approval">): CodexPreset {
  for (const [preset, axes] of Object.entries(CODEX_PRESETS) as [Exclude<CodexPreset, "custom">, Omit<CodexPolicy, "guardian">][]) {
    if (axes.sandbox === policy.sandbox && axes.approval === policy.approval) {
      return preset;
    }
  }
  return "custom";
}

/**
 * Derives a Codex policy from the legacy single permission mode — the fallback
 * when a member has no explicit Codex axes yet (older members / Claude defaults).
 * Mirrors the mapping the adapter used before the two-axis model.
 */
export function codexPolicyFromPermissionMode(mode: string | undefined): CodexPolicy {
  if (mode === "bypassPermissions" || mode === "dontAsk") {
    return { sandbox: "danger-full-access", approval: "never", guardian: false };
  }
  if (mode === "acceptEdits" || mode === "auto") {
    return { sandbox: "workspace-write", approval: "on-request", guardian: false };
  }
  return { sandbox: "read-only", approval: "on-request", guardian: false };
}
