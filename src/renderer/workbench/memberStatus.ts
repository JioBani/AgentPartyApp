import type { PartyMember, SessionView } from "../../shared/types";
import { deriveMemberStatus } from "../../shared/memberDisplayStatus";
import { memberColor } from "../theme/memberColors";
import { parseContextTokens } from "../../shared/modelCatalog";
import { resolveAutoCompact, type AutoCompactSetting } from "../../shared/autoCompact";
import { harnessCapabilities } from "../../shared/harnessCapabilities";
import type { MemberStatus, MemberView, Subagent, TranscriptBlock } from "./types";
import { findRoute, type RouteLike, type RouteVision } from "./routes";

const BUSY_STATUSES = new Set(["requesting", "responding", "interrupting"]);

export function isSessionBusy(session?: SessionView): boolean {
  return session ? BUSY_STATUSES.has(String(session.snapshot.status)) : false;
}

/**
 * Whether the member is waiting on the user to answer an approval prompt.
 *
 * A LIVE session's count is authoritative — the harness knows what it is
 * actually blocked on. The transcript is only consulted for a member with no
 * live session (a closed member, or a freshly reopened app), where it is the
 * only record there is.
 *
 * Scanning the transcript even when a live session reports zero was a bug: an
 * approval block whose resolution never got recorded (the app was killed while
 * the prompt was open) persists to disk, comes back on restore, and pins the
 * member in "approval" forever. Because approval outranks "working" in
 * {@link deriveStatus}, that member could never show as busy again — so its
 * stop control never appeared, no matter how many turns it ran.
 */
function hasPendingApproval(transcript: TranscriptBlock[], session?: SessionView): boolean {
  if (session) {
    return Number(session.snapshot.pendingApprovalCount || 0) > 0;
  }
  return transcript.some((block) => block.kind === "approval" && !block.resolved);
}

/**
 * Gathers this window's facts and hands them to the shared decision table.
 *
 * The ordering used to live here. It moved to `shared/memberDisplayStatus` when
 * the main process had to answer the same question for a phone — which holds no
 * transcript and so cannot re-derive it. Two copies of the ordering would drift;
 * two copies of the FACT-GATHERING is fine, because each side reads what it
 * actually has (this one a transcript, the other the approval index).
 *
 * A note the shared table cannot carry: `not-started` here also covers the
 * app-restart case. A restart clears the stale binding, so a restarted member
 * arrives with no `sessionId` — its conversation is intact and messaging it
 * resumes, which is why that is not `disconnected`.
 */
function deriveStatus(member: PartyMember, session: SessionView | undefined, transcript: TranscriptBlock[]): MemberStatus {
  return deriveMemberStatus({
    stored: member.externalCli ? "external_cli" : member.status,
    hasLiveSession: Boolean(member.sessionId && session),
    busy: isSessionBusy(session),
    pendingApproval: hasPendingApproval(transcript, session),
    // The watchdog appends a "stall" diagnostic as the newest block when a turn
    // goes silent; real activity appends after it and clears this.
    stalled: isStalled(transcript),
  });
}

function isStalled(transcript: TranscriptBlock[]): boolean {
  const last = transcript[transcript.length - 1];
  return Boolean(last && last.kind === "diagnostic" && last.category === "stall");
}

export interface BuildMemberViewInput {
  member: PartyMember;
  sessions: SessionView[];
  transcriptBySession: Record<string, TranscriptBlock[]>;
  /** Per-session subagents, folded from `subagent` events (kept out of the chat). */
  subagentsBySession?: Record<string, Subagent[]>;
  seenCount: number;
  /** Persisted transcript restored from disk — shown when no live session is bound. */
  restored?: TranscriptBlock[];
  /** Model routes, to resolve the effective model's vision (image) support. */
  routes?: RouteLike[];
  /** Global auto-compact default a member without its own setting inherits. */
  compactDefault?: AutoCompactSetting;
  /** True while this member is mid-compaction (transient toolbar spinner). */
  compacting?: boolean;
}

/** Finds a route by a model's route id, runtime id, or display label. */
function routeForModel(model: string, routes?: RouteLike[]): RouteLike | undefined {
  return routes ? findRoute(model, routes) : undefined;
}

/** The effective model's multimodal support, resolved from the routes. */
function visionFor(model: string, routes?: RouteLike[]): RouteVision | undefined {
  return routeForModel(model, routes)?.capabilities?.vision;
}

/** The effective model's selectable effort options (empty when unsupported). */
function effortOptionsFor(model: string, routes?: RouteLike[]): { id: string; label: string }[] {
  const cap = routeForModel(model, routes)?.capabilities?.effort;
  return cap?.supported ? cap.options : [];
}

/**
 * The context-capacity meter data: live occupancy (from the snapshot) over the
 * model's window. The USED count is always the harness's own report — never
 * invented. The WINDOW comes from the harness (Codex reports it numerically)
 * or the catalog `context` string; the live snapshot model can be a runtime
 * string the catalog doesn't list (e.g. "claude-sonnet-4-6"), so we also try
 * the member's configured model id ("sonnet") — a static family property, not
 * an error-masking fallback. When no window resolves, the meter still shows the
 * used count, just without a ratio (never a guessed denominator).
 *
 * A harness without {@link HarnessCapabilities.contextWindow} skips that whole
 * chain: for Cursor there is no window to find, so the catalog string (which
 * describes the vendor's native model, not the variant Cursor serves) would be
 * a guessed denominator rather than a known one.
 *
 * When no live session reports usage yet (a closed member, or a freshly reopened
 * app), it falls back to the member's PERSISTED last-known occupancy so the meter
 * appears immediately — flagged `stale` so the UI marks it not-yet-refreshed
 * instead of pretending it is live. This is why an old chat's cost is visible
 * before you send the first message.
 */
function contextFor(session: SessionView | undefined, member: PartyMember, model: string, configuredModel: string, routes?: RouteLike[]): MemberView["context"] {
  const live = session?.snapshot.contextTokens;
  const stale = !(typeof live === "number" && live > 0);
  const used = stale ? member.lastContextTokens : live;
  if (typeof used !== "number" || used <= 0) {
    return undefined;
  }
  const route = routeForModel(model, routes) || routeForModel(configuredModel, routes);
  const total = harnessCapabilities(member.runtime).contextWindow
    ? session?.snapshot.contextWindow || (stale ? member.lastContextWindow : undefined) || parseContextTokens(route?.meta?.context)
    : undefined;
  return { used, total: total && total > 0 ? total : undefined, stale };
}

/**
 * The window an auto-compaction threshold is sized against, for the dialogs that
 * need one before any usage has been reported. Prefers the live meter, then the
 * member's last known window — but a harness with no window has none to restore
 * either: a Cursor member's PERSISTED value predates this rule and would put the
 * fabricated 500K back on screen.
 */
export function thresholdWindowFor(view: MemberView): number | undefined {
  if (!harnessCapabilities(view.member.runtime).contextWindow) {
    return undefined;
  }
  return view.context?.total || view.member.lastContextWindow;
}

/** Assembles the per-member view consumed by panels, tabs, and the sidebar. */
export function buildMemberView({ member, sessions, transcriptBySession, subagentsBySession, seenCount, restored, routes, compactDefault, compacting }: BuildMemberViewInput): MemberView {
  const session = member.sessionId ? sessions.find((item) => item.id === member.sessionId) : undefined;
  const subagents = session ? (subagentsBySession?.[session.id] || []) : [];
  // A live session's transcript wins (it is seeded from the restored history on
  // resume, so it already contains it); otherwise show the restored history so a
  // closed member — or a reopened app — still displays its past conversation.
  const live = session ? transcriptBySession[session.id] || [] : [];
  const transcript = live.length ? live : (restored || []);
  const status = deriveStatus(member, session, transcript);
  const model = String(session?.snapshot.model || member.model || "");
  return {
    name: member.name,
    color: memberColor(member.name),
    member,
    session,
    status,
    transcript,
    transcriptLoading: restored === undefined,
    subagents,
    unread: Math.max(0, transcript.length - seenCount),
    pendingApproval: status === "approval",
    busy: status === "working",
    model,
    effort: String(session?.snapshot.effort || member.effort || ""),
    thinkingMode: session?.snapshot.thinkingMode || member.reasoning || undefined,
    thinkingBudget: session?.snapshot.thinkingBudget ?? member.reasoningBudget,
    permissionMode: String(session?.snapshot.permissionMode || member.permissionMode || ""),
    cursorPolicy: session?.snapshot.cursorPolicy || member.cursorPolicy,
    vision: visionFor(model, routes),
    effortOptions: effortOptionsFor(model, routes),
    context: contextFor(session, member, model, String(member.model || ""), routes),
    autoCompact: resolveAutoCompact(member.autoCompact, compactDefault),
    compacting: Boolean(compacting),
  };
}

/**
 * The most severe diagnostic among the last few transcript blocks, for the panel
 * header badge — so a reroute / rate-limit / warning is visible without scrolling.
 * Scans the tail only (recent), and error outranks warning outranks info.
 */
export function latestDiagnostic(transcript: TranscriptBlock[]): Extract<TranscriptBlock, { kind: "diagnostic" }> | undefined {
  const rank = (s: string) => (s === "error" ? 3 : s === "warning" ? 2 : 1);
  let best: Extract<TranscriptBlock, { kind: "diagnostic" }> | undefined;
  for (const block of transcript.slice(-12)) {
    if (block.kind === "diagnostic" && (!best || rank(block.severity) >= rank(best.severity))) {
      best = block;
    }
  }
  return best;
}

export function statusLabel(status: MemberStatus): string {
  switch (status) {
    case "working":
      return "working";
    case "stalled":
      return "stalled";
    case "approval":
      return "approval";
    case "not-started":
      return "not started";
    // States only the fact: the session this member is bound to is not there.
    // Not "closed"/"crashed" — we do not know why, and guessing would be its own
    // lie. Not "error"/"failed" either: nothing is broken and nothing is lost;
    // messaging the member starts a fresh session and the conversation resumes.
    case "disconnected":
      return "disconnected";
    // Deliberately not "stopped" or "closed": nothing was lost and nothing is
    // wrong. The process was released to free memory and the next message wakes
    // it — the label exists to explain that first short delay, not to alarm.
    case "sleeping":
      return "sleeping";
    case "external-cli":
      return "CLI";
    // Someone closed this member — here or in another window on the same party.
    // Distinct from `sleeping` (which wakes itself on the next message) and from
    // `not started` (which starts itself): this one waits to be asked.
    case "closed":
      return "closed";
    default:
      return "idle";
  }
}
