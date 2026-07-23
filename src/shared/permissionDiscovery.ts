import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES, DEFAULT_CODEX_POLICY } from "./codexPolicy";
import { PERMISSION_MODE_SETTINGS, harnessDefaultsOf, type AppSettings, type HarnessId } from "./types";
import { CURSOR_AGENT_MODES, CURSOR_APPROVAL_MODES, cursorPolicyOf } from "./cursorPolicy";

/**
 * Machine-readable permission contract exposed by HTTP and member list-models.
 * Creation UIs and AI agents consume the same defaults and closed option sets.
 */
export function permissionDiscoveryFor(settings: AppSettings, harnessId: HarnessId): Record<string, unknown> {
  const defaults = harnessDefaultsOf(settings, harnessId);
  if (harnessId === "codex") {
    return {
      kind: "codexPolicy",
      sandbox: CODEX_SANDBOX_MODES,
      approval: CODEX_APPROVAL_POLICIES,
      guardian: "boolean",
      default: defaults.codexPolicy || DEFAULT_CODEX_POLICY,
    };
  }
  if (harnessId === "cursor") {
    return {
      kind: "cursorPolicy",
      mode: CURSOR_AGENT_MODES,
      approval: CURSOR_APPROVAL_MODES,
      default: cursorPolicyOf(defaults.cursorPolicy, defaults.permissionMode),
    };
  }
  return {
    kind: "permissionMode",
    options: PERMISSION_MODE_SETTINGS,
    default: defaults.permissionMode || "default",
  };
}
