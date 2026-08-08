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
  /**
   * A context-capacity RATIO can be resolved for this harness. Codex reports the
   * window numerically; a Claude member runs a model whose window the catalog
   * knows. The Cursor CLI gives neither — its `stream-json` surface carries one
   * usage frame of four per-turn counters, and its ACP surface carries even less
   * (measured exhaustively against the real CLI, 2026-08-08) — and the catalog's
   * static describes the vendor's native model, not the smaller variant Cursor
   * serves. Without a trustworthy denominator the meter shows the token count
   * alone and auto-compaction stays off (기능정의서 1-14-1 / 1-14-2).
   */
  contextWindow: boolean;
}

const CAPABILITIES: Record<"claude-code" | "codex" | "cursor", HarnessCapabilities> = {
  "claude-code": { twoAxisPermission: false, guardian: false, cloud: false, subagents: true, steer: false, contextWindow: true },
  codex: { twoAxisPermission: true, guardian: true, cloud: true, subagents: true, steer: true, contextWindow: true },
  cursor: { twoAxisPermission: false, guardian: false, cloud: false, subagents: true, steer: false, contextWindow: false },
};

export function harnessCapabilities(harness: string | undefined): HarnessCapabilities {
  return CAPABILITIES[harness === "codex" ? "codex" : harness === "cursor" ? "cursor" : "claude-code"];
}
