import type { PartyMember, SessionView } from "../../shared/types";
import type { AutoCompactSetting } from "../../shared/autoCompact";
import type { ImageAttachment } from "../../shared/attachments";
import type { SubagentActivity, SubagentBlock, SubagentPhase } from "../../shared/subagentActivity";
import type { RouteVision } from "./routes";
import type { ModelProvider } from "./modelProvider";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import type { WorkbenchPanel } from "../../shared/workbenchLayout";

/**
 * One in-session subagent, folded from `subagent` normalized events. Its output
 * is kept out of the member transcript entirely — the dock lists these and the
 * detail view drills into `blocks` (the subagent's own transcript).
 */
export interface Subagent {
  id: string;
  /** Display name / label (Claude description·subagent_type, Codex role·nickname). */
  name: string;
  /** Scope or identity badge (e.g. "auth/**", "#a3f2"). */
  hint?: string;
  role?: string;
  phase: SubagentPhase;
  /** The task delegated to this subagent (shown at the top of the detail view). */
  task?: string;
  /** Meta left/right in the dock row (e.g. "318 tests" · "2m 04s"). */
  tools?: string;
  dur?: string;
  /** Latest one-line activity; the swap point for a future model analyzer. */
  activity?: SubagentActivity;
  /** The subagent's own transcript. */
  blocks: SubagentBlock[];
  updatedAt?: string;
}

/**
 * Per-member transcript block — the rendering contract filled by agent events.
 * Defined in `shared/transcript.ts` because the main process persists it;
 * re-exported here so the renderer keeps its existing import path.
 */
import type { TranscriptBlock } from "../../shared/transcript";

export type { TranscriptBlock };


/**
 * `disconnected` is the member's own `missing_session`: it is bound to a session
 * that nothing is behind any more. It is deliberately NOT folded into
 * `not-started`, which means "never started, message it and it begins" — telling
 * a user that about a member they cannot reach is worse than saying nothing.
 *
 * `sleeping` is the opposite kind of fact: the app released the harness process
 * after a quiet spell to reclaim memory, and the conversation is intact. Shown
 * rather than hidden so the first message's short wake-up delay has a visible
 * cause — and kept distinct from `not-started`, which would wrongly suggest
 * there is no conversation to come back to.
 */
import type { MemberStatus } from "../../shared/memberDisplayStatus";

export type { MemberStatus };

export type PanelDensity = "wide" | "mid" | "narrow";

/**
 * Everything a panel/tab needs about one member, assembled from the party
 * member record, its live session, and its transcript. Components consume this
 * view instead of reaching into raw IPC state.
 */
export interface MemberView {
  name: string;
  color: string;
  member: PartyMember;
  session?: SessionView;
  status: MemberStatus;
  transcript: TranscriptBlock[];
  /** Persisted conversation is still being read; live events stay buffered. */
  transcriptLoading: boolean;
  /** In-session subagents (dock + detail); empty when the member has none. */
  subagents: Subagent[];
  unread: number;
  pendingApproval: boolean;
  busy: boolean;
  model: string;
  effort: string;
  /** Current thinking mode (live snapshot first, else the member's persisted reasoning). */
  thinkingMode?: string;
  /** Current thinking token budget, when set. */
  thinkingBudget?: number;
  permissionMode: string;
  cursorPolicy?: CursorPolicy;
  /**
   * The company behind the effective model (`anthropic`, `openai`, `xai`, …),
   * resolved from `model` on every rebuild so a model change or a status refresh
   * moves the icon with it. Undefined when nothing can identify the model — the
   * icon then falls back to a neutral mark rather than to another brand.
   */
  provider?: ModelProvider;
  /** Effective model's multimodal support, for composer gating + indicators. */
  vision?: RouteVision;
  /** The effective model's selectable effort options (empty when the model has none). */
  effortOptions: { id: string; label: string }[];
  /**
   * Context-window occupancy for the capacity meter. `used` is the current
   * footprint in tokens; `total` is the model's window (undefined when unknown —
   * the meter then shows the raw count without a ratio). `stale` is true when the
   * value is the persisted "last known" occupancy from a prior turn (no live
   * session running yet) — so a reopened member/app shows the meter immediately
   * and marks it as not-yet-refreshed rather than showing nothing.
   */
  context?: { used: number; total?: number; stale?: boolean };
  /**
   * Effective auto-compaction setting (the member's own, else the global
   * default). Drives the toolbar pill, the sidebar badge, and the crossing
   * trigger. Always resolved — never undefined.
   */
  autoCompact: AutoCompactSetting;
  /** True while a manual/automatic compaction is in flight (transient spinner). */
  compacting: boolean;
}

/**
 * One watch-slot. Tabs time-share the slot; `active` is the visible member.
 *
 * Defined in `shared/workbenchLayout.ts` because the main process persists and
 * broadcasts the layout; re-exported here so the renderer keeps its own name.
 */
export type PanelState = WorkbenchPanel;
