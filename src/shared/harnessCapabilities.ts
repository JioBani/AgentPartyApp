/**
 * Per-harness capability flags. The UI branches on these instead of hardcoding
 * `runtime === "codex"` everywhere, so Codex-only controls (two-axis
 * sandbox/approval, guardian, cloud, subagents, steer) are shown only where the
 * harness actually supports them — and a Claude member never gets a control it
 * can't honor. Shared so both main (harness descriptor) and renderer use one
 * source of truth.
 */
export interface HarnessCapabilities {
  /** Two orthogonal permission axes (sandbox mode × approval policy) vs a single mode. */
  twoAxisPermission: boolean;
  /** Guardian (auto_review) — route approvals through a reviewer subagent. */
  guardian: boolean;
  /** Delegate long tasks to a cloud backend. */
  cloud: boolean;
  /** In-thread subagents / collab agents (shown in a Tasks pane, not as members). */
  subagents: boolean;
  /** Steer an in-progress turn (inject guidance mid-turn). */
  steer: boolean;
}

const CAPABILITIES: Record<"claude-code" | "codex", HarnessCapabilities> = {
  "claude-code": { twoAxisPermission: false, guardian: false, cloud: false, subagents: true, steer: false },
  codex: { twoAxisPermission: true, guardian: true, cloud: true, subagents: true, steer: true },
};

export function harnessCapabilities(harness: string | undefined): HarnessCapabilities {
  return CAPABILITIES[harness === "codex" ? "codex" : "claude-code"];
}
