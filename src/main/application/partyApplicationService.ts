import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CreateMemberInput,
  CreatePartyInput,
  PartyCommandResult,
  PartyDefinition,
  PartyMember,
  PartyMessage,
  MemberPermissionInput,
  StartPartyMemberInput,
  SessionView,
  TranscriptSave,
  TranscriptSaveResult,
} from "../../shared/types";
import { HARNESS_IDS, harnessDefaultsOf, isPermissionModeSetting } from "../../shared/types";
import type { AutoCompactSetting } from "../../shared/autoCompact";
import type { ImageAttachment } from "../../shared/attachments";
import { DEFAULT_MAX_IMAGE_BYTES, base64ByteLength } from "../../shared/attachments";
import {
  clearQueue,
  describeQueueFailure,
  enqueue,
  enqueueCutIn,
  mergeInto,
  mergeUp,
  moveItemTo,
  moveItemToFront,
  readQueue,
  removeItem,
  takeItem,
  takeNext,
  type DequeuedTurn,
  type MemberQueueState,
  type QueueCommand,
  type QueuedMessage,
} from "../../shared/messageQueue";
import { log } from "../logger";
import { resolveHarnessOriginal, type HarnessOriginal } from "../harnessOriginal";
import { PartyRepository, StoredPartyState } from "../partyRepository";
import { getSettings } from "../settings";
import { applyEvents, buildTranscriptSave } from "../../shared/transcriptEvents";
import type { TranscriptBlock } from "../../shared/transcript";
import { idleSleepTimeoutMs, sanitizeIdleSleep, type IdleSleepSettings } from "../../shared/idleSleep";
import { layoutsEqual, sanitizeLayout, type WorkbenchLayout } from "../../shared/workbenchLayout";
import type { SessionManager, SessionPartyBinding } from "../sessionManager";
import { invokePartyTool, type PartyBridge, type PartyToolResult } from "../../core/partyBridge";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import { buildModelRoutes } from "../../core/modelRegistry";
import { resolveCatalogModel } from "../../shared/modelCatalog";
import { harnesses } from "../harness/types";
import { DEFAULT_CODEX_POLICY, isCodexPolicy, requireCodexPolicy, type CodexPolicy } from "../../shared/codexPolicy";
import { cursorPolicyOf, requireCursorPolicy, type CursorPolicy } from "../../shared/cursorPolicy";
import { permissionDiscoveryFor } from "../../shared/permissionDiscovery";
import {
  applyMemberGatePatch,
  effectiveGate,
  normalizePartyGate,
  type EffectiveGate,
  type GateReviewer,
  type GateReviewResult,
  classifyGateFailure,
} from "../../shared/messageGate";
import type { GateReviewMessage } from "../../core/messageGateReviewer";
import {
  buildChannelPayload,
  buildPartyMember,
  createPartyDefinition,
  createPartyMessage,
  errorMessage,
  normalizeHarnessId,
  normalizeMemberName,
} from "./partyDomain";
import { crossHarnessLockReason, type HarnessId } from "../../shared/modelIdentity";
import { normalizeMemberMessagingSettings, resolveMemberMessageInterrupt, type MemberMessagingSettings } from "../../shared/memberMessaging";

export interface PartyApplicationDeps {
  sessionManager: SessionManager;
  getWorkspacePath: () => string;
  /**
   * Headless Message Gate reviewer. Injected by the wiring layer (bound to the
   * live router + settings + subscription proxy). Absent → the gate is inert
   * (used by QA harnesses that construct the service directly). See
   * `core/messageGateReviewer.ts`.
   */
  reviewGate?: (message: GateReviewMessage, reviewer: GateReviewer) => Promise<GateReviewResult>;
  /**
   * Discord bridge, injected by the wiring layer. Absent → the discord-* tools
   * report that the bridge is unavailable in this process (a headless/QA engine),
   * rather than silently doing nothing. See `main/discordBridgeService.ts`.
   */
  discord?: DiscordBridgePort;
}

/**
 * What the party tools need from the Discord bridge. Scoped to ONE member — the
 * caller — so an agent can never bridge or post as a teammate.
 */
export interface DiscordBridgePort {
  connectMember(input: { workspacePath: string; party: string; partyLabel?: string; member: string; channelName?: string }): Promise<{ channelName: string; channelId: string; threadName: string; threadId: string; created: boolean }>;
  sendAsMember(workspacePath: string, party: string, member: string, content: string): Promise<{ channelName: string }>;
  sendImageAsMember(
    workspacePath: string,
    party: string,
    member: string,
    image: { dataBase64: string; filename: string; mediaType: string },
    caption?: string,
  ): Promise<{ channelName: string }>;
  disconnectMember(workspacePath: string, party: string, member: string): Promise<{ removed: boolean }> | { removed: boolean };
}

// Mirrors the renderer's BUSY_STATUSES (src/renderer/workbench/memberStatus.ts):
// a session in one of these snapshot states is mid-turn ("working" in the UI).
const BUSY_SESSION_STATUSES = new Set(["requesting", "responding", "interrupting"]);

export class PartyApplicationService {
  private readonly repository = new PartyRepository();

  /**
   * "Which party is active" is NOT a property of this service — it is per-WINDOW
   * state owned by the desktop (AppController), because one engine serves every
   * window of a workspace (two windows opened by running `agent-party` twice share
   * this instance). So every view / member operation takes an EXPLICIT `partyId`
   * from the calling window; the service never resolves the active party from a
   * single shared field (that made two windows switch in lock-step).
   *
   * {@link lastHint} is the ONLY residual "current party" here, and it is purely
   * ADVISORY: it seeds the party a brand-new window (or an HTTP caller that names
   * no window) opens to, and is what gets persisted as `lastActivePartyId`. It is
   * never consulted when an explicit `partyId` is supplied, so it cannot yank a
   * window that has made its own selection.
   */
  private lastHint?: string;
  /**
   * Whether {@link lastHint} has been seeded from the persisted `lastActivePartyId`.
   * Seeding happens EXACTLY once per process, so the advisory default is stable:
   * after it, another process rewriting the shared hint on disk can't drag this
   * process's unselected/HTTP resolution along with it.
   */
  private seededHint = false;

  /**
   * Sessions last seen mid-turn, so the queue drains on the busy → idle EDGE
   * rather than on every idle snapshot. Membership is the previous observation,
   * not a lock: {@link drainQueueForSession} re-checks liveness itself.
   */
  private readonly busySessions = new Set<string>();

  // --- Transcript recording -------------------------------------------------
  //
  // The MAIN process folds the event stream into blocks and writes them. It used
  // to be a window's debounced save, which made the writer a property of the UI:
  // two windows on one member wrote the same file twice and fought over the
  // append anchor (falling back to whole-file saves that queue on the same
  // engine pipe as user turns — a measured 33s delay), and a member driven with
  // NO window open never had its transcript written at all, which is the normal
  // shape for an agent-run party. One session, one writer, windows optional.
  private readonly recordedBlocks = new Map<string, TranscriptBlock[]>();
  /**
   * Exactly what is on disk per session, kept as the ARRAY that was written.
   *
   * Not "the id of the last block": a streaming reply keeps ONE block and grows
   * its text, so anchoring on an id wrote that block at its first delta and then
   * never updated it — a whole answer stored as its first letter. Blocks are
   * rebuilt rather than edited, so `buildTranscriptSave` finds the unchanged
   * prefix by object IDENTITY, which puts a still-growing reply inside the
   * append instead of behind it.
   */
  private readonly recordedPersisted = new Map<string, TranscriptBlock[]>();
  private readonly recordFlushTimers = new Map<string, NodeJS.Timeout>();
  /** Debounce: long enough to batch a streaming reply, short enough to survive a kill. */
  private static readonly RECORD_FLUSH_MS = 1_500;

  constructor(private readonly deps: PartyApplicationDeps) {
    // Record the harness thread as soon as it becomes real — the turn that
    // commits it — instead of hoping something later asks for it. It used to be
    // written only by the renderer's debounced transcript save, which meant a
    // member driven with NO WINDOW OPEN (the normal shape for agent-run party
    // members) never had it written at all, and every one of those members lost
    // its conversation on the next start. Quitting or closing right after a turn
    // lost it for the same reason. Owning the fact here makes all three cases the
    // same case. See #19.
    this.deps.sessionManager.on("events", (payload: { sessionId?: string; events?: { type?: string }[] }) => {
      if (!payload?.sessionId || !payload.events?.length) {
        return;
      }
      this.recordTranscriptEvents(payload.sessionId, payload.events);
      if (!payload.events.some((event) => event?.type === "turn_complete")) {
        return;
      }
      this.persistHarnessThread(payload.sessionId);
    });
    // The queue's delivery trigger: a session leaving a busy status. Driven off
    // the SNAPSHOT rather than `turn_complete` because a turn that is
    // interrupted, errors out, or is force-stopped never completes — and a queue
    // that only drains on clean completion would strand every message behind
    // one stuck turn, which is precisely the state it exists to make visible.
    this.deps.sessionManager.on("snapshot", (payload: { sessionId?: string; snapshot?: { status?: unknown } }) => {
      if (!payload?.sessionId) {
        return;
      }
      const busy = BUSY_SESSION_STATUSES.has(String(payload.snapshot?.status));
      const wasBusy = this.busySessions.has(payload.sessionId);
      if (busy) {
        this.busySessions.add(payload.sessionId);
        return;
      }
      this.busySessions.delete(payload.sessionId);
      // Only on the busy → idle EDGE. Every idle snapshot would otherwise
      // re-enter the drain for a queue that is simply waiting to be sent by hand.
      //
      // A deferred drain RE-ARMS the edge: an adapter can emit an idle-status
      // snapshot a beat before the event that ends the app-side turn lifecycle
      // (codex did, across its cost await), and a one-shot edge consumed in that
      // beat stranded the queued message forever. Keeping the session marked
      // busy makes the NEXT idle snapshot retry instead.
      if (wasBusy && this.drainQueueForSession(payload.sessionId) === "deferred") {
        this.busySessions.add(payload.sessionId);
      }
    });
    this.startIdleSweep();
  }

  /**
   * Persists the owning member's harness thread id for a session whose turn just
   * committed. Silent when nothing changed (the common case: the id is stable for
   * the life of a conversation), and never stores an id the harness would refuse
   * — {@link SessionManager.harnessSessionId} yields nothing before a turn.
   */
  private persistHarnessThread(sessionId: string): void {
    const harnessId = this.deps.sessionManager.harnessSessionId(sessionId);
    if (!harnessId) {
      return;
    }
    this.updateMemberOwnedBySession(sessionId, "member harness thread persisted", (member) => {
      if (member.harnessSessionId === harnessId) {
        return undefined;
      }
      member.harnessSessionId = harnessId;
      return { harnessSessionId: harnessId };
    });
  }

  /**
   * Folds a session's events into transcript blocks and schedules a write.
   *
   * Seeds from what is already on disk the first time it sees a session, so a
   * RESUMED session appends to its history instead of replacing it — the same
   * reason the renderer seeded from the restored copy before it appended.
   */
  private recordTranscriptEvents(sessionId: string, events: unknown[]): void {
    const owner = this.memberOwningSession(sessionId);
    if (!owner) {
      // Not a party member's session (the background usage poller), or the
      // binding has not landed yet. Nothing to attribute the blocks to.
      return;
    }
    if (!this.recordedBlocks.has(sessionId)) {
      const stored = this.repository.readTranscript(this.workspacePath(), this.partyIdOf(owner), owner.name) as TranscriptBlock[];
      this.recordedBlocks.set(sessionId, stored);
      this.recordedPersisted.set(sessionId, stored);
    }
    const before = this.recordedBlocks.get(sessionId) || [];
    const folded = applyEvents({ [sessionId]: before }, sessionId, events as any[])[sessionId] || before;
    if (folded === before) {
      return;
    }
    this.recordedBlocks.set(sessionId, folded);
    this.scheduleTranscriptFlush(sessionId, owner.name, this.partyIdOf(owner));
  }

  private scheduleTranscriptFlush(sessionId: string, member: string, partyId: string | undefined): void {
    if (this.recordFlushTimers.has(sessionId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.recordFlushTimers.delete(sessionId);
      try {
        this.flushTranscript(sessionId, member, partyId);
      } catch (error) {
        // Never silently: a transcript that stops being written looks exactly
        // like a member that stopped talking.
        log("error", "party", "transcript write failed", { member, partyId, error: errorMessage(error) });
      }
    }, PartyApplicationService.RECORD_FLUSH_MS);
    timer.unref?.();
    this.recordFlushTimers.set(sessionId, timer);
  }

  private flushTranscript(sessionId: string, member: string, partyId: string | undefined): void {
    const blocks = this.recordedBlocks.get(sessionId);
    if (!blocks) {
      return;
    }
    const persisted = this.recordedPersisted.get(sessionId);
    if (persisted === blocks) {
      return;
    }
    // Identity diff, not an id anchor: see `recordedPersisted`. A reply still
    // streaming is a REBUILT block, so it lands in the append and keeps growing
    // on disk instead of freezing at its first delta.
    const save: TranscriptSave = buildTranscriptSave(persisted, blocks);
    if (save.afterId && !save.blocks.length) {
      return;
    }
    const result = this.saveMemberTranscript(member, save, partyId);
    if (!result.applied && save.afterId) {
      const full = this.saveMemberTranscript(member, { blocks }, partyId);
      if (!full.applied) {
        log("error", "party", "transcript full save rejected", { member, partyId, reason: full.reason });
        return;
      }
    } else if (!result.applied) {
      log("error", "party", "transcript save rejected", { member, partyId, reason: result.reason });
      return;
    }
    this.recordedPersisted.set(sessionId, blocks);
  }

  /** Drops a closed session's recording state (and writes anything still pending). */
  private stopRecording(sessionId: string): void {
    const timer = this.recordFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.recordFlushTimers.delete(sessionId);
      const owner = this.memberOwningSession(sessionId);
      if (owner) {
        try {
          this.flushTranscript(sessionId, owner.name, this.partyIdOf(owner));
        } catch (error) {
          log("error", "party", "final transcript write failed", { member: owner.name, error: errorMessage(error) });
        }
      }
    }
    this.recordedBlocks.delete(sessionId);
    this.recordedPersisted.delete(sessionId);
  }

  /** The member this session is bound to, or undefined for a non-member session. */
  private memberOwningSession(sessionId: string): PartyMember | undefined {
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    return state.members.find((member) => member.sessionId === sessionId);
  }

  /**
   * Resolves a party id to view/act on: the explicit choice if valid, else this
   * process's advisory hint (the last party created/selected here, seeded once
   * from disk), else the first party. An INVALID explicit id is caught by
   * {@link requireParty}, not here. The live shared `state.currentPartyId` is read
   * only to SEED the hint once — never consulted again, so it cannot yank this
   * process between another process's selections.
   */
  private resolvePartyId(state: StoredPartyState, partyId?: string): string | undefined {
    const valid = (id?: string) => (id && state.parties.some((party) => party.id === id) ? id : undefined);
    if (!this.seededHint) {
      this.seededHint = true;
      this.lastHint = valid(this.lastHint) || valid(state.currentPartyId);
    }
    return valid(partyId) || valid(this.lastHint) || state.parties[0]?.id;
  }

  /** A record's party id — thrown if absent. Every in-memory member/message
   *  carries the party it belongs to (assigned authoritatively on read); a
   *  missing id is a data-invariant violation we surface, never a silent guess. */
  private partyIdOf(record: { partyId?: string; name?: string }): string {
    if (!record.partyId) {
      throw new Error(`'${record.name || "record"}' has no partyId — refusing to guess (data invariant violated).`);
    }
    return record.partyId;
  }

  private membersOf(state: StoredPartyState, partyId: string): PartyMember[] {
    return state.members.filter((member) => this.partyIdOf(member) === partyId);
  }

  private messagesOf(state: StoredPartyState, partyId: string): PartyMessage[] {
    return state.messages.filter((message) => this.partyIdOf(message) === partyId);
  }

  /**
   * The composed party state, memoized per process. A single party switch drives
   * several reads (the broadcast `list()` plus one `getMemberTranscript()` per
   * member being restored); recomposing from disk each time — reparsing every
   * `party.json` — is pure waste. Cache the composed state and reuse it until
   * THIS process writes (explicit {@link invalidate}) or ANOTHER process changes
   * the party LIST (the index mtime moves — a one-stat probe). A concurrent
   * per-party DETAIL edit by another process is the known same-party
   * last-writer-wins limitation, deliberately not covered by the mtime probe.
   * Read-only callers use {@link readState}; mutating methods read fresh so they
   * never alias (and thus mutate) the shared cached object.
   */
  private cache?: { workspace: string; mtimeMs: number; state: StoredPartyState };

  private readState(): StoredPartyState {
    const workspace = this.workspacePath();
    const mtimeMs = this.repository.indexMtimeMs(workspace);
    const hit = this.cache;
    if (hit && hit.workspace === workspace && hit.mtimeMs === mtimeMs) {
      return hit.state;
    }
    const state = this.ensureMigrated(this.repository.read(workspace));
    this.cache = { workspace, mtimeMs, state };
    return state;
  }

  private invalidate(): void {
    this.cache = undefined;
  }

  /** Persists ONE party's detail file (its members + messages) — isolated write. */
  private persistParty(workspace: string, state: StoredPartyState, partyId: string): void {
    this.repository.writeParty(workspace, partyId, this.membersOf(state, partyId), this.messagesOf(state, partyId));
    this.invalidate();
  }

  /** Persists the SHARED party index (list + advisory last-active hint). */
  private persistIndex(workspace: string, state: StoredPartyState): void {
    this.repository.writeIndex(workspace, state.parties, this.resolvePartyId(state));
    this.invalidate();
  }

  list(viewPartyId?: string): { parties: PartyDefinition[]; currentPartyId?: string; members: PartyMember[]; messages: PartyMessage[] } {
    return this.view(this.readState(), viewPartyId);
  }

  createParty(input: CreatePartyInput): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const name = String(input.name || "").trim() || "New Party";
    const party = createPartyDefinition(name);
    // Optional initial Message Gate from the new-party flow (default: off).
    const partyGate = normalizePartyGate(input.gate);
    if (partyGate) {
      party.gate = partyGate;
    }
    state.parties.push(party);
    this.lastHint = party.id;
    // `main` is born from the default creation profile (harness/model/reasoning).
    const main = buildPartyMember({ partyId: party.id, name: "main", requirement: "Primary user-facing agent for this party." }, getSettings());
    state.members.push(main);
    this.writeRoleFile(workspace, main);
    this.persistParty(workspace, state, party.id);
    this.persistIndex(workspace, state);
    log("info", "party", "party created", { workspace, partyId: party.id, name: party.name });
    // Auto-init main's session (no turn — like prewarm) so the party is usable
    // immediately. Non-fatal: a start failure (auth/executable) must not block
    // party creation, but it is surfaced rather than swallowed.
    try {
      const started = this.startMember("main", {}, {}, party.id);
      return { ...started, message: `Party '${party.name}' created with main member.` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("warn", "party", "main session auto-start failed", { workspace, partyId: party.id, error: detail });
      return this.result(`Party '${party.name}' created, but main session did not start: ${detail}`, state, main);
    }
  }

  selectParty(partyId: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const party = this.requireParty(state, partyId);
    // Advisory only: seeds the party a brand-new window opens to. The selecting
    // window's own current party is tracked per-window by the desktop layer.
    this.lastHint = party.id;
    party.updatedAt = new Date().toISOString();
    this.persistIndex(workspace, state);
    return this.result(`Party '${party.name}' selected.`, state, undefined, party.id);
  }

  createMember(input: CreateMemberInput): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const party = this.requireParty(state, input.partyId);
    const member = buildPartyMember({ ...input, partyId: party.id }, getSettings());
    this.assertNotBetaLocked(normalizeHarnessId(member.runtime), member.model);
    if (state.members.some((item) => item.partyId === party.id && item.name === member.name)) {
      throw new Error(`Party member '${member.name}' already exists in '${party.name}'.`);
    }
    state.members.push(member);
    this.writeRoleFile(workspace, member, input.initialTask);
    // Member changes touch only this party's detail file (index untouched), so a
    // concurrent process editing another party of the same workspace can't clobber.
    this.persistParty(workspace, state, party.id);
    log("info", "party", "member created", { workspace, partyId: party.id, member: member.name, runtime: member.runtime });
    return this.result(`Member '${member.name}' created.`, state, member);
  }

  openMember(name: string, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (!member.sessionId) {
      member.status = "opened";
      member.updatedAt = new Date().toISOString();
      this.persistParty(workspace, state, this.partyIdOf(member));
    }
    return this.result(`Member '${member.name}' opened.`, state, member);
  }

  /**
   * Persists a member's per-member auto-compaction threshold. Addressed by NAME
   * (not sessionId) so it works with or without a live session — the threshold is
   * a member config, edited from the toolbar pill / runtime modal / settings even
   * when the member is idle. `undefined` clears the override so the member falls
   * back to the global {@link AppSettings.compactDefault}. Broadcasts so the
   * sidebar badge + toolbar pill update live.
   */
  setMemberAutoCompact(name: string, autoCompact: AutoCompactSetting | undefined, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    member.autoCompact = autoCompact ? { ...autoCompact } : undefined;
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member auto-compact persisted", { workspace, partyId: this.partyIdOf(member), member: member.name, autoCompact });
    return this.result(`Member '${member.name}' auto-compact updated.`, state, member);
  }

  /**
   * Pins a member awake (or lets it follow the global idle-sleep setting again).
   * Turning it on wakes the member if it is already asleep — the setting means
   * "this member must have a process", and leaving it asleep would agree with
   * the words while contradicting the intent.
   */
  setMemberKeepAwake(name: string, keepAwake: boolean, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    const wasSleeping = member.status === "sleeping";
    member.keepAwake = keepAwake || undefined;
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member keep-awake persisted", { workspace, partyId: this.partyIdOf(member), member: member.name, keepAwake });
    if (keepAwake && wasSleeping) {
      return this.wakeMember(member.name, this.partyIdOf(member));
    }
    return this.result(`Member '${member.name}' keep-awake ${keepAwake ? "enabled" : "cleared"}.`, state, member);
  }

  /**
   * Updates the target member's persisted permission through the same service
   * used by HTTP and member tools. If the member is live, the adapter is changed
   * first; persistence happens only after that succeeds, so disk and runtime do
   * not claim different policies. Permission shape follows the concrete
   * selected harness. Cross-routed models retain that harness's permission type.
   */
  setMemberPermission(name: string, input: MemberPermissionInput, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    const harnessId = normalizeHarnessId(member.runtime);
    const liveSessionId = member.sessionId && this.deps.sessionManager.hasSession(member.sessionId) ? member.sessionId : undefined;

    if (harnessId === "codex") {
      const policy = requireCodexPolicy(input.codexPolicy);
      if (liveSessionId) {
        this.deps.sessionManager.setCodexPolicy(liveSessionId, policy);
      }
      member.codexPolicy = policy;
    } else if (harnessId === "cursor") {
      const policy = requireCursorPolicy(input.cursorPolicy);
      if (liveSessionId) {
        this.deps.sessionManager.setCursorPolicy(liveSessionId, policy);
      }
      member.cursorPolicy = policy;
      member.permissionMode = undefined;
    } else {
      if (!isPermissionModeSetting(input.permissionMode)) {
        throw new Error("Claude Code permission requires a valid permissionMode.");
      }
      if (liveSessionId) {
        this.deps.sessionManager.setPermissionMode(liveSessionId, input.permissionMode);
      }
      member.permissionMode = input.permissionMode;
    }

    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member permission updated", {
      workspace,
      partyId: member.partyId,
      member: member.name,
      harnessId,
      permissionMode: member.permissionMode,
      codexPolicy: member.codexPolicy,
      cursorPolicy: member.cursorPolicy,
    });
    return this.result(`Member '${member.name}' permission updated.`, state, member);
  }

  /**
   * Persists a member's Message Gate override as a PATCH (axes: mode / rule /
   * reviewer; a `null` axis clears it back to inherit, a full-inherit result
   * stores no override). Addressed by NAME so ANY member/HTTP/agent may edit ANY
   * member's gate — cross-editing is intentionally unrestricted per the spec.
   * Broadcasts so every gate surface updates live. See `shared/messageGate.ts`.
   */
  setMemberGate(name: string, patch: unknown, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    member.gate = applyMemberGatePatch(member.gate, patch);
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member gate updated", { workspace, partyId: this.partyIdOf(member), member: member.name, gate: member.gate });
    return this.result(`Member '${member.name}' message gate updated.`, state, member);
  }

  /** Sets or clears the sender-specific interrupt default for member messages. */
  setMemberOutboundInterrupt(name: string, value: unknown, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (value !== null && value !== undefined && typeof value !== "boolean") {
      throw new Error("outboundInterrupt must be true, false, or null (inherit).");
    }
    if (typeof value === "boolean") member.outboundInterrupt = value;
    else delete member.outboundInterrupt;
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member outbound interrupt updated", {
      workspace,
      partyId: this.partyIdOf(member),
      member: member.name,
      outboundInterrupt: member.outboundInterrupt,
    });
    return this.result(`Member '${member.name}' message interrupt default updated.`, state, member);
  }

  /**
   * Persists the party-wide Message Gate default (enablement + rule text). Any
   * member with mode "inherit" follows this. Party-level state lives in the
   * shared index, so this writes the index (mirrors {@link selectParty}).
   */
  setPartyGate(partyId: string | undefined, gate: unknown): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const party = this.requireParty(state, partyId);
    party.gate = normalizePartyGate(gate) || { enabled: false, rule: "" };
    party.updatedAt = new Date().toISOString();
    this.persistIndex(workspace, state);
    log("info", "party", "party gate updated", { workspace, partyId: party.id, gate: party.gate });
    return this.result(`Party '${party.name}' message gate updated.`, state, undefined, party.id);
  }

  startMember(name: string, rawInput?: StartPartyMemberInput | null, rawOptions?: { mock?: boolean; autoReply?: boolean } | null, partyId?: string): PartyCommandResult {
    // See respawnMember: `null` from an IPC/HTTP caller bypasses a TS default.
    const input = rawInput ?? {};
    const options = rawOptions ?? {};
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    // An OPPORTUNISTIC start (renderer prewarm on panel open) races member
    // close: the prewarm could execute after the close and silently resurrect
    // the member with a fresh session (the smoke-e2e "queued message was
    // delivered" flake). Closed is an explicit user decision — only a
    // deliberate start/resume (no `auto`) may reopen it.
    if (input.auto && member.status === "closed") {
      log("info", "party", "auto-start skipped: member is closed", { workspace, partyId: member.partyId, member: member.name });
      return this.result(`Member '${member.name}' is closed; auto-start skipped.`, state, member);
    }
    // Same rule for a member the app just put to sleep, and the guard has to live
    // HERE rather than only in the renderer's prewarm. The panel effect that
    // prewarms deliberately excludes the actions object from its deps, so it can
    // fire with a members list captured before the sleep landed — which restarted
    // the process within a tick of releasing it, and no member could ever stay
    // asleep. Waking is an explicit act (a message, or resume/wake); an
    // opportunistic start is not one.
    if (input.auto && member.status === "sleeping") {
      log("info", "party", "auto-start skipped: member is sleeping", { workspace, partyId: member.partyId, member: member.name });
      return this.result(`Member '${member.name}' is sleeping; auto-start skipped.`, state, member);
    }
    // Idempotence has to reach ACROSS processes, not just this one.
    //
    // `sessionViewOf` below can only see sessions this process owns, so a member
    // already running under a sibling app process on the same workspace looked
    // exactly like a member with no session at all — and we started a second
    // harness for it, overwriting `sessionId` and abandoning the first. The
    // party store is shared on disk, so two instances on one workspace did this
    // to each other on every launch, party switch, tab restore and delivery.
    // Measured on a live install: one member with EIGHT live `claude` processes
    // on the same conversation, 2.5 GB, still climbing.
    //
    // The binding already records its owner (`sessionBootId`), and
    // `sessionOwnerMayBeAlive` already answers whether that owner is still
    // running — `reconcileStaleSessionBindings` uses it to decide whether to
    // KEEP the binding. Starting simply never consulted it. One owner per member
    // at a time; the other side must reach it through its owner, not clone it.
    if (member.sessionId && !this.deps.sessionManager.hasSession(member.sessionId) && sessionOwnerMayBeAlive(member.sessionBootId)) {
      log("info", "party", "start skipped: member is running in another app process", {
        workspace,
        partyId: member.partyId,
        member: member.name,
        sessionId: member.sessionId,
        owner: member.sessionBootId,
      });
      return this.result(
        `Member '${member.name}' is already running in another AgentParty process (${member.sessionBootId}). Use that window, or close it there first.`,
        state,
        member,
      );
    }
    // Start is an idempotent ensure operation. UI prewarm, HTTP automation, and
    // a send can arrive in adjacent event-loop turns; creating again used to
    // orphan the first live adapter while overwriting member.sessionId, yielding
    // exactly the "session is active but the member doesn't recognize it"
    // failure. Runtime changes belong to respawn/setters, not a duplicate start.
    const existing = this.sessionViewOf(member.sessionId);
    if (existing) {
      log("info", "party", "member start reused live session", {
        workspace,
        partyId: member.partyId,
        member: member.name,
        sessionId: existing.id,
      });
      return { ...this.result(`Member '${member.name}' session is already running.`, state, member), session: existing };
    }
    this.applyRuntimeDefaults(member, input);
    const session = this.createMemberSession(workspace, member, input, options);
    member.sessionId = session.id;
    member.sessionBootId = SESSION_BOOT_ID;
    member.status = "running";
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, member.partyId || "default");
    log("info", "party", "member session started", { workspace, partyId: member.partyId, member: member.name, sessionId: session.id, cwd: workspace });
    return { ...this.result(`Member '${member.name}' session started.`, state, member), session };
  }

  resumeMember(name: string, partyId?: string): PartyCommandResult {
    return this.startMember(name, {}, {}, partyId);
  }

  /**
   * Reloads the member's session while CONTINUING the conversation: it tears the
   * current session down and starts a new one that resumes the same harness
   * thread (model context intact). Because the new session is rebuilt from the
   * member's current config and re-reads the harness's MCP config, this is how
   * you apply changes that need a session restart — e.g. a just-added MCP server —
   * without losing the conversation. Contrast with a hard restart (adapter
   * restart with no resume), which begins an EMPTY conversation.
   *
   * The live harness thread id is captured from the running session BEFORE
   * teardown (not read from the debounced-persisted value), so the resume always
   * targets the exact current conversation.
   */
  respawnMember(name: string, rawInput?: StartPartyMemberInput | null, partyId?: string): PartyCommandResult {
    // A TS default (`= {}`) only fires on `undefined`. This is public API — IPC
    // and HTTP callers both reach it, and both can deliver a literal `null` for
    // an omitted body — so normalize explicitly instead of trusting the default.
    const input = rawInput ?? {};
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    const requestedHarness = input.selectedHarnessId ? normalizeHarnessId(input.selectedHarnessId) : undefined;
    const currentHarness = normalizeHarnessId(member.runtime);
    const changesHarness = Boolean(requestedHarness && requestedHarness !== currentHarness);
    const nextHarness = requestedHarness || currentHarness;
    this.assertNotBetaLocked(nextHarness, input.model || member.model);
    if (changesHarness && this.memberHasStartedTurn(member)) {
      throw new Error(`Cannot change harness for '${member.name}' after its first turn has started.`);
    }
    if (member.sessionId) {
      const harnessId = this.deps.sessionManager.harnessSessionId(member.sessionId);
      if (!changesHarness && harnessId && harnessId !== member.harnessSessionId) {
        member.harnessSessionId = harnessId;
        member.updatedAt = new Date().toISOString();
        this.persistParty(workspace, state, this.partyIdOf(member));
      }
    }
    if (changesHarness) {
      // Claude conversation ids and Codex thread ids are not interchangeable.
      // RuntimeModal only permits this before the first turn, so discard the
      // prewarm thread rather than handing its id to the other adapter.
      member.harnessSessionId = undefined;
      member.runtime = requestedHarness || member.runtime;
      member.updatedAt = new Date().toISOString();
      this.persistParty(workspace, state, this.partyIdOf(member));
      log("info", "party", "member harness changed", { workspace, partyId: member.partyId, member: member.name, from: currentHarness, to: nextHarness });
    }
    this.closeMember(name, partyId);
    return this.startMember(name, input, {}, partyId);
  }

  /**
   * Sends a user turn to a member — the SINGLE path behind both the UI Send
   * button and the HTTP API, so an agent drives the exact same route a user
   * does. Idempotently ensures the member has a live session (starting it with
   * the member's own persisted config when absent — never a duplicate when one
   * is already active), then delivers the raw user turn plus any image
   * attachments. Distinct from {@link sendMessage}, which wraps inter-member
   * channel messages.
   */
  /**
   * A user turn addressed to one member. `interrupt` stops an in-flight turn and
   * parks the message at the FRONT of the app queue so the idle drain handles it
   * next — the Discord bridge always sets it, because a person who typed on their
   * phone is waiting, and a long autonomous turn would otherwise swallow the
   * instruction for minutes. Never hands a busy harness a turn directly: that
   * would land in the adapter buffer where the user can neither see nor cancel
   * it (#23). The compaction exception mirrors {@link sendMessage}: never tear
   * down a compaction half-way; the message still parks at the front and waits.
   */
  sendUserMessage(name: string, text: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean }): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    let session: SessionView | undefined;
    let sessionId = member.sessionId && this.deps.sessionManager.hasSession(member.sessionId) ? member.sessionId : undefined;
    // Interrupt is meaningful only for a turn that existed when this message
    // arrived. Starting/waking an idle member must not create a turn and then
    // immediately stop it with the same message.
    const turnWasActive = sessionId ? this.isSessionBusy(sessionId) : false;
    if (!sessionId) {
      const started = this.startMember(member.name, {}, {}, this.partyIdOf(member));
      session = started.session;
      sessionId = session?.id;
    }
    if (!sessionId) {
      throw new Error(`Could not start a session for member '${member.name}'.`);
    }
    // Busy: always the app queue. `interrupt` only changes WHERE in the queue
    // and WHETHER the turn is stopped — never whether the harness is handed the
    // turn while still working.
    if (turnWasActive) {
      const cutIn = options?.interrupt === true;
      const compacting = this.deps.sessionManager.isCompacting(sessionId);
      return this.enqueueForMember(member.name, this.partyIdOf(member), { text, attachments, from: null }, {
        front: cutIn,
        stop: cutIn && !compacting,
      });
    }
    this.deps.sessionManager.sendUserTurn(sessionId, text, attachments);
    // Re-read: startMember wrote the new sessionId/status; reflect it back.
    const fresh = this.ensureMigrated(this.repository.read(workspace));
    const target = this.requireMember(fresh, member.name, this.partyIdOf(member));
    log("info", "party", "user turn sent", { workspace, partyId: target.partyId, member: target.name, sessionId, images: attachments?.length || 0 });
    return { ...this.result(`Message sent to '${target.name}'.`, fresh, target), session };
  }

  // ===========================================================================
  // Message queue — messages a busy member has been sent but not yet handed.
  //
  // Ownership sits here rather than in the harness adapters because everything
  // the user wants to do with a waiting message (see it, cancel it, edit it,
  // reorder it, merge it) is impossible once the turn has crossed into the
  // adapter. The adapter's own buffer remains as the race-window net: a member
  // can go idle between our busy check and the send, and that turn is simply
  // delivered normally. Interrupt-on-send parks at the front and stops the
  // turn; it does NOT bypass this queue (#23). See src/shared/messageQueue.ts.
  // ===========================================================================

  /** The member's queue as stored, normalized (a member predating this feature reads as empty). */
  private queueOf(member: PartyMember): MemberQueueState {
    return readQueue(member.queue);
  }

  /**
   * Persists a member's queue and tells the windows. Every queue mutation lands
   * here, so a change can never be applied without also becoming visible — the
   * queue is only useful if what is on screen is what is actually waiting.
   */
  private writeQueue(name: string, partyId: string | undefined, next: MemberQueueState, logMessage: string): { state: StoredPartyState; member: PartyMember } {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    member.queue = next;
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", logMessage, { workspace, partyId: member.partyId, member: member.name, queued: next.items.length });
    this.deps.sessionManager.notifyPartyChanged(workspace);
    return { state, member };
  }

  /**
   * Parks a message on a member's queue. Refusals (queue full, empty body) are
   * thrown, never absorbed: a caller that believes it queued a message the app
   * actually dropped is exactly the failure mode the queue exists to remove.
   *
   * `front` + `stop` is the interrupt / "지금 바로 처리" shape: record the row
   * first, then stop the turn, so the idle drain is the only path into the
   * harness and the user can still cancel until that edge fires.
   */
  private enqueueForMember(
    name: string,
    partyId: string | undefined,
    input: { text: string; attachments?: ImageAttachment[]; from: string | null },
    options?: { front?: boolean; stop?: boolean },
  ): PartyCommandResult {
    const current = this.readState();
    const member = this.requireMember(current, name, partyId);
    const item: QueuedMessage = {
      id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: input.text,
      from: input.from,
      at: new Date().toISOString(),
      attachments: input.attachments,
    };
    const result = options?.front ? enqueueCutIn(this.queueOf(member), item) : enqueue(this.queueOf(member), item);
    if (!result.ok) {
      throw new Error(describeQueueFailure(result.reason));
    }
    // Persist BEFORE any interrupt: a stop that raced ahead of the write would
    // let the idle drain run against a queue that does not yet hold this item,
    // and the next turn would miss it (#23 order invariant).
    const written = this.writeQueue(
      member.name,
      this.partyIdOf(member),
      result.value,
      options?.front ? "message queued at front (interrupt)" : "message queued",
    );
    if (options?.stop) {
      const sessionId = written.member.sessionId;
      if (sessionId && this.deps.sessionManager.hasSession(sessionId)) {
        this.deps.sessionManager.interrupt(sessionId);
      }
    }
    const sender = input.from ? `'${input.from}'` : "the user";
    return {
      ...this.result(`Queued for '${member.name}' (${result.value.items.length} waiting) — from ${sender}.`, written.state, written.member),
      queued: true,
      queue: result.value,
    };
  }

  /**
   * The single entry point for every queue mutation, so the UI button and the
   * HTTP endpoint provably run the same code. Failures propagate as thrown
   * errors — the caller turns them into a visible notice rather than a silent
   * no-op (see {@link describeQueueFailure}).
   */
  runQueueCommand(name: string, command: QueueCommand, partyId?: string): PartyCommandResult & { text?: string } {
    switch (command.action) {
      case "send":
        return this.sendQueuedNow(name, partyId);
      case "clear":
        return this.clearMemberQueue(name, partyId);
      case "preference":
        return this.setMemberQueuePreference(name, { merge: command.merge, collapsed: command.collapsed }, partyId);
      case "sendItem":
        return this.sendQueuedItem(name, command.itemId, partyId);
      case "cancel":
        return this.cancelQueuedMessage(name, command.itemId, partyId);
      case "edit":
        return this.editQueuedMessage(name, command.itemId, partyId);
      case "move":
        return this.moveQueuedMessage(name, command.itemId, command.toIndex, partyId);
      case "mergeUp":
        return this.mergeQueuedMessageUp(name, command.itemId, partyId);
      case "mergeInto":
        return this.mergeQueuedMessageInto(name, command.itemId, command.targetId, partyId);
    }
  }

  /** Reads a member's queue without mutating anything (the HTTP GET and the UI's initial paint). */
  getMemberQueue(name: string, partyId?: string): MemberQueueState {
    return this.queueOf(this.requireMember(this.readState(), name, partyId));
  }

  /**
   * Hands one turn from the queue to the harness and announces the delivery.
   *
   * Order matters: the `queue_dequeued` event is published BEFORE the turn is
   * sent, so the user's bubble is already in the transcript when the reply
   * starts streaming into it. The queue is persisted after a confirmed send, so
   * the only possible failure is a re-send — never a message that is gone from
   * the queue and was never delivered.
   */
  private deliverFromQueue(member: PartyMember, take: { state: MemberQueueState; turn: DequeuedTurn }, logMessage: string): PartyCommandResult {
    const sessionId = member.sessionId;
    if (!sessionId || !this.deps.sessionManager.hasSession(sessionId)) {
      throw new Error(`'${member.name}' has no live session — its queue was left untouched.`);
    }
    // The one-queue invariant, enforced where the handover happens rather than
    // trusted to every caller: a turn handed to a busy harness lands in the
    // adapter's own buffer, and that buffer is a queue the user can neither see
    // nor take back.
    if (this.isSessionBusy(sessionId)) {
      throw new Error(`'${member.name}' is still working — its queue is delivered when the turn ends.`);
    }
    this.deps.sessionManager.emitAppEvent(sessionId, {
      type: "queue_dequeued",
      text: take.turn.text,
      from: take.turn.from,
      count: take.turn.count,
      at: new Date().toISOString(),
    });
    // A member's message is queued as its RAW body (so the queue row shows prose,
    // not XML) and only wrapped in the channel envelope here, at delivery — which
    // is also the first moment the envelope's contents are actually true.
    // Attribution survives the wait too: it still bills as a party message.
    const payload = take.turn.from
      ? buildChannelPayload(createPartyMessage(member, take.turn.text, take.turn.from), member)
      : take.turn.text;
    this.deps.sessionManager.sendUserTurn(sessionId, payload, take.turn.attachments, take.turn.from ? "party-message" : "user");
    const written = this.writeQueue(member.name, this.partyIdOf(member), take.state, logMessage);
    return {
      ...this.result(`Delivered ${take.turn.count} queued message(s) to '${member.name}'.`, written.state, written.member),
      queue: take.state,
    };
  }

  /**
   * Drains the front of a member's queue now that its turn finished. Re-checks
   * busy first: a member that has already picked up new work must not be handed
   * another turn on top of it. Returns `"deferred"` when there IS something to
   * deliver but the turn lifecycle still reads active — the caller re-arms the
   * busy→idle edge so the next idle snapshot retries instead of stranding it.
   */
  private drainQueueForSession(sessionId: string): "delivered" | "deferred" | "none" {
    const state = this.readState();
    const member = state.members.find((item) => item.sessionId === sessionId);
    if (!member) {
      return "none";
    }
    const queue = this.queueOf(member);
    if (!queue.items.length) {
      return "none";
    }
    if (this.isSessionBusy(sessionId)) {
      return "deferred";
    }
    const take = takeNext(queue);
    if (!take.ok) {
      return "none";
    }
    try {
      this.deliverFromQueue(member, take.value, "queue auto-drained");
      return "delivered";
    } catch (error) {
      // Never silent: a queue that stopped draining looks identical to a member
      // that is merely slow, and the user would wait forever for a reply.
      log("error", "party", "queue auto-drain failed", { member: member.name, error: String(error) });
      return "deferred";
    }
  }

  /**
   * "지금 보내기" for the leading run.
   *
   * On an idle member this delivers. On a BUSY one it stops the turn instead of
   * pushing the message through: handing a turn to a busy harness would move the
   * message out of this queue and into the adapter's own buffer, where it waits
   * for exactly the same moment — turn end — but can no longer be seen, edited
   * or cancelled. The user would trade away every control they have and gain not
   * one second. Stopping is the only thing that actually makes it sooner, so it
   * is what the button does, and the label says so.
   */
  sendQueuedNow(name: string, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const queue = this.queueOf(member);
    const take = takeNext(queue);
    if (!take.ok) {
      throw new Error(describeQueueFailure(take.reason));
    }
    if (this.isSessionBusy(member.sessionId)) {
      return this.stopForQueue(member, queue, "queue send-now stopped the turn");
    }
    return this.deliverFromQueue(member, take.value, "queue sent on demand");
  }

  /** "지금 보내기" on one row — same rule, and the row jumps the queue on its way. */
  sendQueuedItem(name: string, itemId: string, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const queue = this.queueOf(member);
    if (this.isSessionBusy(member.sessionId)) {
      const front = moveItemToFront(queue, itemId);
      if (!front.ok) {
        throw new Error(describeQueueFailure(front.reason));
      }
      return this.stopForQueue(member, front.value, "queue send-now stopped the turn");
    }
    const take = takeItem(queue, itemId);
    if (!take.ok) {
      throw new Error(describeQueueFailure(take.reason));
    }
    return this.deliverFromQueue(member, take.value, "queued item sent on demand");
  }

  /**
   * Stops the in-flight turn and leaves the queue to the idle drain.
   *
   * Deliberately does NOT send: the drain fires on the busy→idle edge and is the
   * one place a turn is handed over, so there is still exactly one path into the
   * harness and no window where both could fire.
   */
  private stopForQueue(member: PartyMember, queue: MemberQueueState, logMessage: string): PartyCommandResult {
    const sessionId = member.sessionId;
    if (!sessionId || !this.deps.sessionManager.hasSession(sessionId)) {
      throw new Error(`'${member.name}' has no live session — its queue was left untouched.`);
    }
    const written = this.writeQueue(member.name, this.partyIdOf(member), queue, logMessage);
    this.deps.sessionManager.interrupt(sessionId);
    return {
      ...this.result(`Stopped '${member.name}' — its queue is delivered as soon as the turn ends.`, written.state, written.member),
      queue,
    };
  }

  /**
   * Cancels one queued message. A miss is an error, not a no-op: the item was
   * almost certainly delivered a moment ago, and reporting success would leave
   * the user believing they stopped a message the agent is already answering.
   */
  cancelQueuedMessage(name: string, itemId: string, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const removal = removeItem(this.queueOf(member), itemId);
    if (!removal.ok) {
      throw new Error(describeQueueFailure(removal.reason));
    }
    const written = this.writeQueue(member.name, this.partyIdOf(member), removal.value.state, "queued message cancelled");
    return { ...this.result(`Cancelled a queued message for '${member.name}'.`, written.state, written.member), queue: removal.value.state };
  }

  /**
   * Pulls a queued message back out for editing. The text goes to the caller
   * (the composer puts it back in the input box); the queue only loses the row
   * once it has been handed over, so an edit can never lose the message.
   */
  editQueuedMessage(name: string, itemId: string, partyId?: string): PartyCommandResult & { text?: string } {
    const member = this.requireMember(this.readState(), name, partyId);
    const removal = removeItem(this.queueOf(member), itemId);
    if (!removal.ok) {
      throw new Error(describeQueueFailure(removal.reason));
    }
    const written = this.writeQueue(member.name, this.partyIdOf(member), removal.value.state, "queued message taken back for editing");
    return {
      ...this.result(`Returned a queued message to the composer for '${member.name}'.`, written.state, written.member),
      queue: removal.value.state,
      text: removal.value.removed.text,
    };
  }

  /** Puts one queued message at an absolute position — the drop half of a drag. */
  moveQueuedMessage(name: string, itemId: string, toIndex: number, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const moved = moveItemTo(this.queueOf(member), itemId, toIndex);
    if (!moved.ok) {
      throw new Error(describeQueueFailure(moved.reason));
    }
    const written = this.writeQueue(member.name, this.partyIdOf(member), moved.value, "queued message moved");
    return { ...this.result(`Reordered the queue for '${member.name}'.`, written.state, written.member), queue: moved.value };
  }

  /** Folds a queued message into the one above it ("위와 합치기"); same sender only. */
  mergeQueuedMessageUp(name: string, itemId: string, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const merged = mergeUp(this.queueOf(member), itemId);
    if (!merged.ok) {
      throw new Error(describeQueueFailure(merged.reason));
    }
    const written = this.writeQueue(member.name, this.partyIdOf(member), merged.value, "queued messages merged");
    return { ...this.result(`Merged two queued messages for '${member.name}'.`, written.state, written.member), queue: merged.value };
  }

  /**
   * Folds one queued message into another — dropping a message onto a message.
   * The dragged one lands after the target's text; same sender only.
   */
  mergeQueuedMessageInto(name: string, itemId: string, targetId: string, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const merged = mergeInto(this.queueOf(member), itemId, targetId);
    if (!merged.ok) {
      throw new Error(describeQueueFailure(merged.reason));
    }
    const written = this.writeQueue(member.name, this.partyIdOf(member), merged.value, "queued messages merged");
    return { ...this.result(`Merged two queued messages for '${member.name}'.`, written.state, written.member), queue: merged.value };
  }

  /** Empties a member's queue ("모두 취소"). */
  clearMemberQueue(name: string, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const cleared = clearQueue(this.queueOf(member));
    const written = this.writeQueue(member.name, this.partyIdOf(member), cleared, "queue cleared");
    return { ...this.result(`Cleared the queue for '${member.name}'.`, written.state, written.member), queue: cleared };
  }

  /** Per-member queue preferences: merge-on-send and the collapsed/expanded panel state. */
  setMemberQueuePreference(name: string, preference: { merge?: boolean; collapsed?: boolean }, partyId?: string): PartyCommandResult {
    const member = this.requireMember(this.readState(), name, partyId);
    const current = this.queueOf(member);
    const next: MemberQueueState = {
      ...current,
      merge: preference.merge === undefined ? current.merge : preference.merge,
      collapsed: preference.collapsed === undefined ? current.collapsed : preference.collapsed,
    };
    const written = this.writeQueue(member.name, this.partyIdOf(member), next, "queue preference updated");
    return { ...this.result(`Updated the queue preference for '${member.name}'.`, written.state, written.member), queue: next };
  }

  /**
   * The persisted transcript (assembled UI blocks) for a member, restored on load.
   * Locating the member uses the CACHED composed state (no extra disk parse), so
   * restoring every member of a party on a switch no longer recomposes the whole
   * store per member — the dominant redundant cost this path used to pay.
   */
  getMemberTranscript(name: string, partyId?: string): unknown[] {
    const state = this.readState();
    const member = this.requireMember(state, name, partyId);
    return this.repository.readTranscript(this.workspacePath(), this.partyIdOf(member), member.name);
  }

  /**
   * Where the HARNESS keeps its own full copy of this member's conversation.
   *
   * The app's transcript has a retention window; the harness file does not. So
   * once a member's window is full, this is where the rest of the history still
   * is. Returns `original: null` when the member has not produced a harness
   * session yet, or the harness does not keep one we can name.
   */
  getHarnessOriginal(name: string, partyId?: string): { ok: true; original: HarnessOriginal | null } {
    const member = this.requireMember(this.readState(), name, partyId);
    const sessionId = member.harnessSessionId
      || (member.sessionId ? this.deps.sessionManager.harnessSessionId(member.sessionId) : undefined);
    // A member's cwd IS its workspace (the locked workspace model), which is
    // exactly the key Claude Code derives its directory name from.
    return { ok: true, original: resolveHarnessOriginal(member.runtime, sessionId, this.workspacePath()) ?? null };
  }

  /**
   * One extracted transcript image, as a data URL.
   *
   * Screenshots are persisted out-of-line (see `shared/transcriptImages.ts`), so
   * the transcript a window loads carries references instead of megabytes of
   * base64. The bytes are fetched here, per image, only when one is actually
   * displayed. Reading it over this path (rather than a file:// URL) keeps the
   * renderer sandboxed and lets a REMOTE engine serve its own images.
   */
  getTranscriptImage(file: string): { ok: true; dataUrl: string; bytes: number } {
    const resolved = this.repository.imagePath(this.workspacePath(), file);
    if (!resolved) {
      throw new Error(`Transcript image '${file}' is not a name inside the image store.`);
    }
    const bytes = fs.readFileSync(resolved);
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream";
    return { ok: true, dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`, bytes: bytes.byteLength };
  }

  /**
   * The workbench tab layout for a party, or undefined when none is stored yet
   * (the renderer then seeds one from the member list).
   */
  getPartyLayout(partyId?: string): WorkbenchLayout | undefined {
    const state = this.readState();
    const id = partyId || state.currentPartyId;
    return id ? this.repository.readLayout(this.workspacePath(), id) : undefined;
  }

  /**
   * Records a party's tab layout. This service is the single writer, so every
   * window on the party converges instead of each keeping its own copy of a
   * shared localStorage key — the shape that let a tab closed in one window stay
   * open in another and then come back on relaunch.
   *
   * Returns whether anything actually changed, so the caller can skip a
   * broadcast: layouts arrive on every drag frame and a re-broadcast of an
   * identical layout would fight the dragging window for its own state.
   */
  setPartyLayout(layout: unknown, partyId?: string): { changed: boolean; partyId?: string; layout?: WorkbenchLayout } {
    const state = this.readState();
    // The RESOLVED id is returned, not the requested one: a window that has not
    // pinned a party sends none, and the caller broadcasting to "windows on that
    // party" must compare against what was actually written.
    const id = partyId || state.currentPartyId;
    const next = sanitizeLayout(layout);
    if (!id || !next) {
      return { changed: false };
    }
    const current = this.repository.readLayout(this.workspacePath(), id);
    if (layoutsEqual(current, next)) {
      return { changed: false, partyId: id, layout: next };
    }
    this.repository.writeLayout(this.workspacePath(), id, next);
    return { changed: true, partyId: id, layout: next };
  }

  /**
   * Persists a member's transcript to disk (called debounced by the renderer, the
   * transcript's assembler). Also captures the member's live harness thread id so
   * a later reopen resumes that thread — keeping the record and the model context.
   *
   * `save.afterId` makes this an append; the returned `applied: false` asks the
   * caller for a full save when the anchor no longer exists.
   */
  saveMemberTranscript(name: string, save: TranscriptSave, partyId?: string): TranscriptSaveResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    const result = this.repository.writeTranscript(workspace, this.partyIdOf(member), member.name, save);
    if (!result.applied) {
      return result;
    }
    let changed = false;
    const harnessId = member.sessionId ? this.deps.sessionManager.harnessSessionId(member.sessionId) : undefined;
    if (harnessId && harnessId !== member.harnessSessionId) {
      member.harnessSessionId = harnessId;
      changed = true;
    }
    // Capture the live context-window occupancy alongside the thread id, so a
    // reopened member/app can show its context meter before the first new turn.
    changed = this.captureContextOccupancy(member) || changed;
    if (changed) {
      member.updatedAt = new Date().toISOString();
      this.persistParty(workspace, state, this.partyIdOf(member));
    }
    return result;
  }

  /**
   * Copies the member's live session context occupancy (tokens + window) onto the
   * persisted member. Returns whether anything changed. Only positive numbers are
   * captured — an absent/zero live report leaves the last-known value intact
   * rather than wiping the meter (the occupancy is non-cumulative and briefly
   * unreported between turns; the persisted value is the honest "last known").
   */
  private captureContextOccupancy(member: PartyMember): boolean {
    const snap = this.sessionViewOf(member.sessionId)?.snapshot;
    if (!snap) {
      return false;
    }
    let changed = false;
    if (typeof snap.contextTokens === "number" && snap.contextTokens > 0 && member.lastContextTokens !== snap.contextTokens) {
      member.lastContextTokens = snap.contextTokens;
      changed = true;
    }
    if (typeof snap.contextWindow === "number" && snap.contextWindow > 0 && member.lastContextWindow !== snap.contextWindow) {
      member.lastContextWindow = snap.contextWindow;
      changed = true;
    }
    return changed;
  }

  /**
   * Applies one persisted runtime-setting change to the member that owns a
   * session. Callers retain responsibility for validating and comparing their
   * setting; this method owns the shared lookup, timestamp, persistence, and
   * diagnostic lifecycle.
   */
  private updateMemberOwnedBySession(
    sessionId: string,
    logMessage: string,
    update: (member: PartyMember) => Record<string, unknown> | undefined,
  ): void {
    if (!sessionId) {
      return;
    }
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = state.members.find((item) => item.sessionId === sessionId);
    if (!member) {
      // No owning member means this runtime change has nowhere to be persisted
      // and WILL be lost on the next restart. Surface it instead of dropping it
      // quietly, so a broken session↔member binding stays diagnosable.
      log("warn", "party", "runtime change not persisted — no member owns this session", { workspace, sessionId, change: logMessage });
      return;
    }
    const details = update(member);
    if (!details) {
      return;
    }
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", logMessage, {
      workspace,
      partyId: member.partyId,
      member: member.name,
      ...details,
    });
  }

  /**
   * Persists a runtime permission-mode change back to the member that owns the
   * live session, so reopening the member (or restarting the app) restores the
   * mode the user last chose — the analogue of {@link saveMemberTranscript}
   * capturing the live harness thread id. A no-op when no member is bound to the
   * session (e.g. a non-party session) or the value is unchanged, so the setter
   * path stays universal and writes only when something actually moved.
   */
  syncMemberPermissionMode(sessionId: string, permissionMode: string): void {
    if (!sessionId) {
      return;
    }
    if (!isPermissionModeSetting(permissionMode)) {
      // Surface rather than silently drop: an unknown mode reaching here means an
      // upstream contract drifted, and persisting it would corrupt the member.
      log("warn", "party", "ignoring unknown permission mode for member persistence", { sessionId, permissionMode });
      return;
    }
    this.updateMemberOwnedBySession(sessionId, "member permission mode persisted", (member) => {
      if (member.permissionMode === permissionMode) {
        return undefined;
      }
      member.permissionMode = permissionMode;
      return { permissionMode };
    });
  }

  /** Persists a live Codex policy change on the owning party member. */
  syncMemberCodexPolicy(sessionId: string, policy: CodexPolicy): void {
    if (!sessionId) {
      return;
    }
    if (!isCodexPolicy(policy)) {
      log("warn", "party", "invalid Codex policy reached member persistence", { sessionId, policy });
      return;
    }
    this.updateMemberOwnedBySession(sessionId, "member Codex policy persisted", (member) => {
      if (
        member.codexPolicy?.sandbox === policy.sandbox
        && member.codexPolicy?.approval === policy.approval
        && member.codexPolicy?.guardian === policy.guardian
      ) {
        return undefined;
      }
      member.codexPolicy = { ...policy };
      return { policy };
    });
  }

  /** Persists a live Cursor agent-mode + approval-mode change. */
  syncMemberCursorPolicy(sessionId: string, policy: CursorPolicy): void {
    if (!sessionId) {
      return;
    }
    const validated = requireCursorPolicy(policy);
    this.updateMemberOwnedBySession(sessionId, "member Cursor policy persisted", (member) => {
      if (
        member.cursorPolicy?.mode === validated.mode
        && member.cursorPolicy?.approval === validated.approval
      ) {
        return undefined;
      }
      member.cursorPolicy = { ...validated };
      member.permissionMode = undefined;
      return { policy: validated };
    });
  }

  /**
   * Persists a runtime model change back to the owning member — the model
   * analogue of {@link syncMemberPermissionMode}. Without this, a member whose
   * model was switched mid-session (e.g. sonnet → opus) silently reverted to the
   * stale start-time model on the next app restart, because resume reads
   * `member.model`. Expects the catalog/route id (what the setter APIs receive),
   * never a display label.
   */
  /**
   * Refuses a (model, harness) pair the beta locks (B-12). Enforcement lives on
   * the MUTATIONS, not only in the catalog list, because the list is one of four
   * ways in: the member wizard, `POST /api/party/members`, the party
   * `member-create` tool and a live model change all end up here.
   */
  private assertNotBetaLocked(harnessId: HarnessId, model: string | undefined): void {
    const reason = model ? crossHarnessLockReason(model, harnessId) : undefined;
    if (reason) {
      throw new Error(reason);
    }
  }

  /**
   * {@link assertNotBetaLocked} for a live session, resolved through the member
   * that owns it — a session carries no harness of its own. Called before the
   * model is applied so a locked pair never reaches the adapter.
   */
  assertSessionModelAllowed(sessionId: string, model: string): void {
    if (!sessionId || !model) {
      return;
    }
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const member = state.members.find((item) => item.sessionId === sessionId);
    if (member) {
      this.assertNotBetaLocked(normalizeHarnessId(member.runtime), model);
    }
  }

  syncMemberModel(sessionId: string, model: string): void {
    if (!sessionId || !model) {
      return;
    }
    // Persist the catalog id for Anthropic models regardless of the spelling
    // the setter received (harness canonical id, OpenRouter slug, label) — a
    // raw "anthropic/claude-opus-4.8" here later resolved to the codex
    // OpenRouter route and re-billed a subscription model to the OR key.
    const entry = resolveCatalogModel(model);
    const value = entry && entry.provider === "anthropic" ? entry.id : model;
    this.updateMemberOwnedBySession(sessionId, "member model persisted", (member) => {
      if (member.model === value) {
        return undefined;
      }
      member.model = value;
      return { model: value };
    });
  }

  /** Persists a runtime thinking change back to the owning member (same rationale as {@link syncMemberModel}). */
  syncMemberThinking(sessionId: string, reasoning: string, reasoningBudget?: number): void {
    if (!sessionId || !reasoning) {
      return;
    }
    this.updateMemberOwnedBySession(sessionId, "member thinking persisted", (member) => {
      if (member.reasoning === reasoning && (reasoningBudget === undefined || member.reasoningBudget === reasoningBudget)) {
        return undefined;
      }
      member.reasoning = reasoning;
      if (reasoningBudget !== undefined) {
        member.reasoningBudget = reasoningBudget;
      }
      return { reasoning, reasoningBudget };
    });
  }

  /** Persists a runtime effort change back to the owning member (same rationale as {@link syncMemberModel}). */
  syncMemberEffort(sessionId: string, effort: string): void {
    if (!sessionId || !effort) {
      return;
    }
    this.updateMemberOwnedBySession(sessionId, "member effort persisted", (member) => {
      if (member.effort === effort) {
        return undefined;
      }
      member.effort = effort;
      return { effort };
    });
  }

  bindMember(name: string, sessionId: string, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (!this.deps.sessionManager.hasSession(sessionId)) {
      throw new Error(`Session '${sessionId}' is not active.`);
    }
    member.sessionId = sessionId;
    member.sessionBootId = SESSION_BOOT_ID;
    member.status = "running";
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member bound to session", { workspace, partyId: member.partyId, member: member.name, sessionId });
    return this.result(`Member '${member.name}' bound to active session.`, state, member);
  }

  /**
   * Records the member's live harness thread id onto the in-hand record so the
   * conversation stays reachable. Mutates without persisting — the caller owns
   * the state it read and writes it back, so persisting here would be clobbered
   * by that later write. Safe at any teardown point: `harnessSessionId` yields
   * nothing before a turn has committed, so this never stores an id the harness
   * would refuse to resume.
   */
  private captureHarnessThread(member: PartyMember): boolean {
    if (!member.sessionId) {
      return false;
    }
    const harnessId = this.deps.sessionManager.harnessSessionId(member.sessionId);
    if (!harnessId || harnessId === member.harnessSessionId) {
      return false;
    }
    member.harnessSessionId = harnessId;
    log("info", "party", "captured harness thread at teardown", { member: member.name, partyId: member.partyId, harnessSessionId: harnessId });
    return true;
  }

  // ===========================================================================
  // Idle sleep — releasing a quiet member's process while keeping its conversation.
  //
  // A party holds one harness process per member for as long as the member
  // exists, each costing real memory whether or not anyone is talking to it.
  // Sleep gives that back: the process ends, `harnessSessionId` keeps the
  // conversation, and the next message resumes it. `startMember` already resumes
  // that thread and its auto-start guard already refuses only `closed`, so
  // WAKING needs no new machinery — a sleeping member is simply started again.
  //
  // The whole design rests on one asymmetry: being too cautious costs memory,
  // and being too eager destroys work. Every judgement below leans the first way.
  // ===========================================================================

  /** Matches the stall watchdog's cadence; the timeout, not this, sets the delay. */
  private static readonly IDLE_SWEEP_MS = 20_000;
  private idleSweepTimer: NodeJS.Timeout | undefined;
  /** Members whose refusal has been logged, so the sweep says each reason once. */
  private readonly reportedSleepRefusals = new Map<string, string>();

  private startIdleSweep(): void {
    if (this.idleSweepTimer) {
      return;
    }
    this.idleSweepTimer = setInterval(() => {
      try {
        this.sweepIdleMembers();
      } catch (error) {
        // Never let a sweep failure kill the timer: the next tick should try
        // again, and a silent stop would look exactly like "sleep is disabled".
        log("warn", "party", "idle sweep failed", { error: errorMessage(error) });
      }
    }, PartyApplicationService.IDLE_SWEEP_MS);
    this.idleSweepTimer.unref?.();
  }

  /**
   * Why this member must keep its process despite being quiet. Undefined means
   * there is no reason to keep it.
   *
   * These are the MEMBER-level refusals; the session-level ones (a turn in
   * flight, an unanswered prompt, a compaction, detached background work) are
   * applied by {@link SessionManager.idleCandidates} before we get here.
   */
  private sleepRefusal(member: PartyMember): string | undefined {
    if (member.keepAwake) {
      return "keep-awake is set";
    }
    // Cursor spawns a process per TURN and holds none between them, so there is
    // nothing to reclaim — only its session id and queue to lose.
    if (member.runtime === "cursor") {
      return "cursor holds no process between turns";
    }
    if (readQueue(member.queue).items.length > 0) {
      return "messages are waiting in its queue";
    }
    return undefined;
  }

  /**
   * Releases every member that has been quiet past the configured timeout.
   *
   * Sleeps by NAME rather than against the state read here: each sleep does its
   * own read-modify-write, so reusing this snapshot would write one member's
   * change over the previous member's.
   */
  /**
   * The desktop's idle-sleep policy, pushed in rather than read from disk.
   *
   * This service may be running INSIDE a WSL distro, where `getSettings()` reads
   * that host's settings.json — a different file from the one the user edited on
   * the desktop. Reading locally meant a remote workspace silently ignored the
   * configured timeout and ran on the built-in default forever. Undefined until
   * the first push (a local engine, or startup), where the local file is right.
   */
  setIdleSleep(settings: IdleSleepSettings): void {
    this.idleSleepPolicy = sanitizeIdleSleep(settings);
    log("info", "party", "idle sleep policy applied", { workspace: this.workspacePath(), ...this.idleSleepPolicy });
  }

  private idleSleepPolicy: IdleSleepSettings | undefined;

  /** Desktop-owned Runtime policy, pushed to remote engines just like idle sleep. */
  setMemberMessaging(settings: MemberMessagingSettings): void {
    this.memberMessagingPolicy = normalizeMemberMessagingSettings(settings);
    log("info", "party", "member messaging policy applied", { workspace: this.workspacePath(), ...this.memberMessagingPolicy });
  }

  private memberMessagingPolicy: MemberMessagingSettings | undefined;

  private sweepIdleMembers(): void {
    const idleSleep = this.idleSleepPolicy || getSettings().idleSleep;
    if (!idleSleep.enabled) {
      return;
    }
    const candidates = this.deps.sessionManager.idleCandidates(idleSleepTimeoutMs(idleSleep));
    if (!candidates.length) {
      // Why nothing was eligible, at debug level only. A member that never
      // sleeps is otherwise silent and indistinguishable from a disabled
      // feature — the exact shape of the bugs this feature already shipped.
      if (getSettings().debugEnabled) {
        log("info", "party", "idle sweep found nothing", { thresholdMs: idleSleepTimeoutMs(idleSleep), sessions: this.deps.sessionManager.describeIdleState() });
      }
      return;
    }
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const sleepable: { name: string; partyId?: string; quietMs: number }[] = [];
    for (const candidate of candidates) {
      const member = state.members.find((entry) => entry.sessionId === candidate.id);
      if (!member) {
        continue; // Not a party member's session (the background usage poller).
      }
      const key = `${member.partyId}/${member.name}`;
      // sleepMember re-checks this; asking here only keeps the log honest about
      // WHY a member the sweep looked at is still awake.
      const refusal = this.sleepRefusal(member);
      if (refusal) {
        // Said once per distinct reason: a member that never sleeps is otherwise
        // indistinguishable from a feature that is quietly not working.
        if (this.reportedSleepRefusals.get(key) !== refusal) {
          this.reportedSleepRefusals.set(key, refusal);
          log("info", "party", "member stays awake", { partyId: member.partyId, member: member.name, reason: refusal });
        }
        continue;
      }
      this.reportedSleepRefusals.delete(key);
      sleepable.push({ name: member.name, partyId: this.partyIdOf(member), quietMs: candidate.quietMs });
    }
    for (const entry of sleepable) {
      try {
        this.sleepMember(entry.name, entry.partyId, entry.quietMs);
      } catch (error) {
        log("warn", "party", "could not sleep member", { member: entry.name, error: errorMessage(error) });
      }
    }
  }

  /**
   * Ends a member's harness process but keeps the member reachable: its status
   * becomes `sleeping` and `harnessSessionId` carries the conversation, so the
   * next message resumes rather than restarts it.
   *
   * Runs without an `await` from the capture through the persist. The engine is
   * single-threaded, so an uninterrupted stretch is what makes this atomic with
   * respect to an arriving message — yield in the middle and a send could be
   * handed an adapter that is being torn down, where the turn is accepted into a
   * buffer that dispose then discards.
   */
  sleepMember(name: string, partyId?: string, quietMs?: number): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    const sessionId = member.sessionId;
    if (!sessionId || !this.deps.sessionManager.hasSession(sessionId)) {
      return this.result(`Member '${member.name}' holds no live session to release.`, state, member);
    }
    // Every refusal is checked HERE rather than only in the sweep, so a
    // hand-driven sleep cannot do what the sweep would refuse. Calling this by
    // hand skips the waiting, not the safety — otherwise the one path a person
    // reaches for is the one that can destroy running background work.
    const blocker = this.sleepRefusal(member) || this.deps.sessionManager.sleepBlocker(sessionId);
    if (blocker) {
      log("info", "party", "sleep refused", { workspace, partyId: member.partyId, member: member.name, reason: blocker });
      return this.result(`Member '${member.name}' stays awake: ${blocker}.`, state, member);
    }
    // First, and before anything can fail: after closeSession the adapter is gone
    // and with it the only way to learn the thread id that makes waking a
    // continuation instead of a brand-new conversation.
    this.captureHarnessThread(member);
    this.stopRecording(sessionId);

    this.deps.sessionManager.closeSession(sessionId);
    const at = new Date().toISOString();
    member.sessionId = undefined;
    member.sessionBootId = undefined;
    member.status = "sleeping";
    member.sleptAt = at;
    member.updatedAt = at;
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member slept", {
      workspace,
      partyId: member.partyId,
      member: member.name,
      sessionId,
      quietMs,
      harnessSessionId: member.harnessSessionId,
    });
    return { ...this.result(`Member '${member.name}' is sleeping; a message wakes it.`, state, member) };
  }

  /**
   * Wakes a member for a message already parked on its queue, off the sender's
   * turn. Failure is surfaced on the member (and in the log) rather than left as
   * a message that silently never arrives — the queue keeps it, so a later wake
   * still delivers it.
   *
   * Serialised through {@link wakingMembers}: a broadcast to a sleeping party
   * would otherwise start every process at once, briefly costing more memory
   * than never sleeping at all.
   */
  private wakeForQueuedMessage(name: string, partyId?: string): void {
    const key = `${partyId || "default"}/${name}`;
    if (this.wakingMembers.has(key)) {
      return;
    }
    this.wakingMembers.add(key);
    setImmediate(() => {
      try {
        this.wakeMember(name, partyId);
      } catch (error) {
        log("error", "party", "could not wake a member with a queued message", { member: name, partyId, error: errorMessage(error) });
      } finally {
        this.wakingMembers.delete(key);
      }
    });
  }

  /** Members with a wake in flight, so one member is never started twice at once. */
  private readonly wakingMembers = new Set<string>();

  /**
   * Brings a sleeping member back. Plain {@link startMember}: it already resumes
   * `harnessSessionId`, so there is nothing sleep-specific to undo beyond the
   * status, which starting rewrites anyway.
   */
  wakeMember(name: string, partyId?: string): PartyCommandResult {
    const result = this.startMember(name, {}, {}, partyId);
    // A member woken while messages were waiting must not sit on them until
    // something else happens to nudge the queue: the normal drain trigger is the
    // busy → idle EDGE, and a fresh session never crosses it.
    const sessionId = result.member?.sessionId;
    if (sessionId && this.deps.sessionManager.hasSession(sessionId)) {
      this.drainQueueForSession(sessionId);
    }
    return result;
  }

  closeMember(name: string, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (member.sessionId) {
      // Capture the harness thread BEFORE tearing the session down: it is the
      // only way back into this conversation. It used to be recorded solely by
      // the renderer's debounced transcript save, so closing right after a turn
      // — or closing a member driven with no window open at all — dropped it,
      // and the member's next message silently began an empty conversation.
      this.captureHarnessThread(member);
      this.stopRecording(member.sessionId);

      this.deps.sessionManager.closeSession(member.sessionId);
    }
    member.sessionId = undefined;
    member.sessionBootId = undefined;
    member.status = "closed";
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member closed", { workspace, partyId: member.partyId, member: member.name });
    return this.result(`Member '${member.name}' closed.`, state, member);
  }

  removeMember(name: string, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (member.name === "main") {
      throw new Error("Main member cannot be removed. Remove or recreate the party instead.");
    }
    if (member.sessionId) {
      this.stopRecording(member.sessionId);

      this.deps.sessionManager.closeSession(member.sessionId);
    }
    state.members = state.members.filter((item) => !(item.partyId === member.partyId && item.name === member.name));
    state.messages = state.messages.filter((message) => message.partyId !== member.partyId || (message.from !== member.name && message.to !== member.name));
    fs.rmSync(this.repository.memberDir(workspace, this.partyIdOf(member), member.name), { recursive: true, force: true });
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member removed", { workspace, partyId: member.partyId, member: member.name });
    return this.result(`Member '${member.name}' removed.`, state);
  }

  /**
   * Permanently deletes a whole party: closes every live session it owns, drops
   * its members/messages, and removes its on-disk storage. If the deleted party
   * was active, focus falls to another party (or none, if it was the last one).
   */
  removeParty(partyId: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const party = state.parties.find((item) => item.id === partyId);
    if (!party) {
      throw new Error(`Party '${partyId}' does not exist.`);
    }
    for (const member of state.members) {
      if (member.partyId === party.id && member.sessionId) {
        this.stopRecording(member.sessionId);

        this.deps.sessionManager.closeSession(member.sessionId);
      }
    }
    state.parties = state.parties.filter((item) => item.id !== party.id);
    state.members = state.members.filter((item) => item.partyId !== party.id);
    state.messages = state.messages.filter((message) => message.partyId !== party.id);
    if (this.lastHint === party.id) {
      // The advisory hint pointed at the deleted party — fall to another. (Each
      // window's own current party is cleaned up separately by the desktop layer.)
      this.lastHint = state.parties[0]?.id;
    }
    fs.rmSync(this.repository.partyDir(workspace, party.id), { recursive: true, force: true });
    // Party removed from the shared list → index write only (its detail dir is gone).
    this.persistIndex(workspace, state);
    log("info", "party", "party removed", { workspace, partyId: party.id, name: party.name });
    return this.result(`Party '${party.name}' removed.`, state);
  }

  /**
   * The Message Gate entry for member-originated sends: reviews the message
   * against the sender's effective gate BEFORE delivery, then delegates to the
   * sync {@link sendMessage} delivery primitive. This is the single async seam
   * the gate needs; the delivery path stays sync so its result type is unchanged.
   *
   *   - `from === "user"` (a human turn) is never gated.
   *   - `force` bypasses review (the escape hatch), surfaced as a "forced" badge.
   *   - reject → NOT delivered; a rejected message is recorded and the caller
   *     gets the reason (the `send` tool returns it so the agent rewrites).
   *   - reviewer error → fail-open: delivered unreviewed + a "failed" badge.
   */
  async sendGatedMessage(
    to: string,
    content: string,
    from = "user",
    attachments?: ImageAttachment[],
    partyId?: string,
    options?: { interrupt?: boolean; force?: boolean; forceReason?: string },
  ): Promise<PartyCommandResult> {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const target = this.requireMember(state, to, partyId);
    const targetPartyId = this.partyIdOf(target);
    const sender = from !== "user"
      ? state.members.find((member) => member.partyId === targetPartyId && member.name === normalizeMemberName(from))
      : undefined;

    if (sender && this.deps.reviewGate) {
      const gate = this.effectiveGateOf(sender, state);
      if (gate.active && !options?.force) {
        let verdict: GateReviewResult;
        try {
          verdict = await this.deps.reviewGate(
            { rule: gate.rule, from: sender.name, to: target.name, fromRole: sender.role, toRole: target.role, content },
            gate.reviewer,
          );
        } catch (error) {
          // Fail-open: deliver unreviewed, but surface the failure (never silent).
          // The badge alone is not enough — it needs a LIVE sender session, and
          // the reviewer being unreachable (e.g. its subscription not connected)
          // is exactly the case where nothing else says so. Report it on the
          // result too, so HTTP/MCP/IPC callers cannot read this as a success.
          const detail = errorMessage(error);
          // Record the failure as a gate-review turn as well. Only the SUCCESS
          // path used to write one, so a gate that was failing open left a
          // ledger showing 100% clean reviews — its error rate could not be
          // measured at all, which is how "the gate is on" and "the gate is
          // actually running" drifted apart unnoticed. Telemetry must never
          // break delivery, so this stays best-effort like its success twin.
          this.deps.sessionManager.recordGateReview?.(workspace, {
            partyId: targetPartyId,
            member: sender.name,
            model: gate.reviewer.model,
            failure: { layer: classifyGateFailure(error), detail },
          });
          this.emitGateBadge(sender, { gate: "failed", to: target.name, from: sender.name, reason: detail, errcode: "reviewer_error" });
          log("warn", "party", "message gate review failed (fail-open)", { workspace, partyId: targetPartyId, from: sender.name, to: target.name, reviewer: gate.reviewer.model, error: detail });
          const delivered = this.sendMessage(to, content, from, attachments, partyId, { interrupt: options?.interrupt });
          const notice = `Message gate reviewer '${gate.reviewer.model}' is unavailable, so the message was delivered UNREVIEWED: ${detail}`;
          return {
            ...delivered,
            message: `${delivered.message} ${notice}`,
            // Compose, never replace: the delivery layer may have its own
            // diagnostic here (e.g. target_member_has_no_active_session), and
            // dropping it to report the gate would just move the blind spot.
            ...(delivered.partyMessage
              ? { partyMessage: { ...delivered.partyMessage, error: delivered.partyMessage.error ? `${delivered.partyMessage.error}; ${notice}` : notice } }
              : {}),
          };
        }
        // Record the review's measured token spend + verdict as a gate-review
        // ledger turn (overhead attributed to the sender's party) so the Token
        // Usage dashboard can price the gate and show its reject rate. Telemetry
        // must never break delivery, so the ledger append is best-effort.
        this.deps.sessionManager.recordGateReview?.(workspace, {
          partyId: targetPartyId,
          member: sender.name,
          model: gate.reviewer.model,
          verdict: verdict.verdict,
          usage: verdict.usage,
        });
        if (verdict.verdict === "reject") {
          const message = createPartyMessage(target, content, from);
          message.delivered = false;
          message.error = verdict.reason || "Message rejected by the message gate.";
          target.updatedAt = message.createdAt;
          state.messages.push(message);
          this.persistParty(workspace, state, targetPartyId);
          this.emitGateBadge(sender, { gate: "rejected", to: target.name, from: sender.name, reason: verdict.reason, rule: gate.rule });
          log("info", "party", "message gate rejected", { workspace, partyId: targetPartyId, from: sender.name, to: target.name });
          return { ...this.result(`Message to '${target.name}' was rejected by the message gate.`, state, target), partyMessage: message };
        }
        // allow → fall through to delivery.
      } else if (gate.active && options?.force) {
        this.emitGateBadge(sender, { gate: "forced", to: target.name, from: sender.name, reason: options.forceReason });
      }
    }
    return this.sendMessage(to, content, from, attachments, partyId, { interrupt: options?.interrupt });
  }

  /** The effective Message Gate applied to a member (member override → party → settings default). */
  private effectiveGateOf(member: PartyMember, state: StoredPartyState): EffectiveGate {
    const party = state.parties.find((item) => item.id === member.partyId);
    return effectiveGate(member.gate, party?.gate, getSettings().gateDefaults);
  }

  /** Surfaces a Message Gate outcome as an inline badge in the SENDER's transcript (UI-only). */
  private emitGateBadge(
    sender: PartyMember,
    gate: { gate: "rejected" | "forced" | "failed"; to: string; from?: string; reason?: string; rule?: string; errcode?: string },
  ): void {
    if (sender.sessionId && this.deps.sessionManager.hasSession(sender.sessionId)) {
      this.deps.sessionManager.emitGateBadge(sender.sessionId, gate);
    }
  }

  sendMessage(to: string, content: string, from = "user", attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean }): PartyCommandResult {
    const workspace = this.workspacePath();
    let state = this.ensureMigrated(this.repository.read(workspace));
    let target = this.requireMember(state, to, partyId);
    // A human turn has a separate composer preference. This inheritance chain
    // applies only when the recorded sender is another member in this party.
    const sender = state.members.find((member) => member.name === from && this.partyIdOf(member) === this.partyIdOf(target));
    const interrupt = sender
      ? resolveMemberMessageInterrupt(options?.interrupt, sender.outboundInterrupt, this.memberMessagingPolicy || getSettings().memberMessaging)
      : options?.interrupt === true;
    const message = createPartyMessage(target, content, from);
    // R-63: an open tab without a live session used to record
    // `target_member_has_no_active_session` and never deliver. User turns already
    // auto-start; party messages must do the same for any non-closed member.
    // Closed tabs stay refused — closing is an explicit "do not wake me".
    // If auto-start itself cannot run (stubbed harness, missing runtime), fall
    // through to the no-session diagnostic instead of crashing the send path.
    let sessionId = target.sessionId && this.deps.sessionManager.hasSession(target.sessionId) ? target.sessionId : undefined;
    // Freeze the arrival-time fact. A sleeping/not-started member may transition
    // through startup statuses while this send wakes it, but there was no turn
    // to interrupt when the sender acted.
    const turnWasActive = sessionId ? this.isSessionBusy(sessionId) : false;
    // A sleeping member is woken OUT OF BAND: park the message on the member's
    // own durable queue, answer the sender immediately, and bring the process
    // back behind them. Waking a remote (WSL) member is a round trip, and making
    // the sender wait for it would stall a whole turn of theirs on someone
    // else's process start. The queue is the same one a busy member uses, so the
    // message stays visible and cancellable while the wake runs, and a wake that
    // fails is reported rather than losing it.
    if (!sessionId && target.status === "sleeping") {
      message.error = "queued_for_sleeping_member";
      target.updatedAt = message.createdAt;
      state.messages.push(message);
      this.persistParty(workspace, state, this.partyIdOf(target));
      const queued = this.enqueueForMember(target.name, this.partyIdOf(target), { text: message.content, attachments, from: message.from }, { front: false, stop: false });
      log("info", "party", "message queued for sleeping member", { workspace, partyId: target.partyId, from: message.from, to: message.to });
      this.wakeForQueuedMessage(target.name, this.partyIdOf(target));
      return { ...queued, partyMessage: message };
    }
    if (!sessionId && target.status !== "closed") {
      try {
        const started = this.startMember(target.name, {}, {}, this.partyIdOf(target));
        state = this.ensureMigrated(this.repository.read(workspace));
        target = this.requireMember(state, to, this.partyIdOf(target));
        sessionId = started.session?.id
          || (target.sessionId && this.deps.sessionManager.hasSession(target.sessionId) ? target.sessionId : undefined);
        if (sessionId) {
          message.targetSessionId = sessionId;
        }
      } catch (error) {
        log("warn", "party", "auto-start for party message failed", {
          workspace,
          partyId: target.partyId,
          member: target.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (sessionId) {
      if (turnWasActive) {
        // Busy: same visible queue a user's message uses. `interrupt` parks at
        // the front and stops the turn (unless compacting); it never hands the
        // harness a turn while still working — that was the uncancellable path
        // (#23). Record the routing first, THEN enqueue: the other order writes
        // this (pre-enqueue) state snapshot over the queue the enqueue just
        // saved, silently losing the message.
        const cutIn = interrupt;
        const compacting = this.deps.sessionManager.isCompacting(sessionId);
        message.error = "queued_for_busy_member";
        target.updatedAt = message.createdAt;
        state.messages.push(message);
        this.persistParty(workspace, state, this.partyIdOf(target));
        log("info", "party", "message queued for busy member", { workspace, partyId: target.partyId, from: message.from, to: message.to, interrupt: cutIn });
        return {
          ...this.enqueueForMember(target.name, this.partyIdOf(target), { text: message.content, attachments, from: message.from }, {
            front: cutIn,
            stop: cutIn && !compacting,
          }),
          partyMessage: message,
        };
      }
      // A member-to-member message drove this turn — tag it so the usage ledger
      // attributes the recipient's spend to `party-message` (an overhead trigger).
      this.deps.sessionManager.sendUserTurn(sessionId, buildChannelPayload(message, target), attachments, "party-message");
      message.delivered = true;
      target.status = "running";
    } else {
      message.error = target.status === "closed"
        ? "target_member_is_closed"
        : "target_member_has_no_active_session";
      if (target.status !== "closed") {
        target.status = target.sessionId ? "missing_session" : "opened";
      }
    }
    target.updatedAt = message.createdAt;
    state.messages.push(message);
    this.persistParty(workspace, state, this.partyIdOf(target));
    log("info", "party", "message routed", { workspace, partyId: target.partyId, from: message.from, to: message.to, delivered: message.delivered, targetSessionId: message.targetSessionId });
    return {
      ...this.result(message.delivered ? `Message delivered to '${target.name}'.` : `Message queued for '${target.name}', but no active session is bound.`, state, target),
      partyMessage: message,
    };
  }

  /**
   * Turn state of one member (or, with no name, every member of the party).
   * `turnActive` mirrors the UI's "working" derivation: the session snapshot
   * status is one of the busy states. Backs the `member-status` party tool and
   * the `/api/party/members/{name}/status` endpoint.
   */
  memberTurnStatus(name?: string, partyId?: string): { ok: true; members: Array<Record<string, unknown>> } {
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const members = name ? [this.requireMember(state, name, partyId)] : this.membersOf(state, this.requireParty(state, partyId).id);
    return { ok: true, members: members.map((member) => this.turnStatusOf(member)) };
  }

  /**
   * Stops a member's in-flight turn. Throws if the member has no live session;
   * an idle member is reported (interrupted: false), not an error — "make sure
   * it is stopped" is a legitimate call.
   */
  interruptMember(name: string, partyId?: string): PartyCommandResult & { interrupted: boolean } {
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const member = this.requireMember(state, name, partyId);
    if (!member.sessionId || !this.deps.sessionManager.hasSession(member.sessionId)) {
      throw new Error(`Member '${member.name}' has no active session to interrupt.`);
    }
    const wasBusy = this.isSessionBusy(member.sessionId);
    if (wasBusy) {
      this.deps.sessionManager.interrupt(member.sessionId);
    }
    log("info", "party", "member interrupt requested", { partyId: member.partyId, member: member.name, wasBusy });
    return {
      ...this.result(wasBusy ? `Interrupt requested for '${member.name}'.` : `Member '${member.name}' is not in a turn (idle).`, state, member),
      interrupted: wasBusy,
    };
  }

  /**
   * Force-releases a member's stuck turn — the manual "강제 종료" the composer
   * offers once a Stop has gone unanswered.
   *
   * Unlike {@link interruptMember} this does NOT ask the harness to stop; it
   * releases the app-side turn so input stops queueing behind a turn that will
   * never complete. It is therefore valid precisely when the member still looks
   * busy after an interrupt — so, unlike interrupt, a non-busy member is a no-op
   * rather than an error.
   */
  forceStopMember(name: string, partyId?: string): PartyCommandResult & { released: boolean } {
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const member = this.requireMember(state, name, partyId);
    if (!member.sessionId || !this.deps.sessionManager.hasSession(member.sessionId)) {
      throw new Error(`Member '${member.name}' has no active session to force-stop.`);
    }
    const wasBusy = this.isSessionBusy(member.sessionId);
    if (wasBusy) {
      this.deps.sessionManager.forceStop(member.sessionId);
    }
    log("info", "party", "member force stop", { partyId: member.partyId, member: member.name, wasBusy });
    return {
      ...this.result(wasBusy ? `Force-stopped '${member.name}'.` : `Member '${member.name}' is not in a turn (idle).`, state, member),
      released: wasBusy,
    };
  }

  /** Stops every busy member of the party (optionally excluding the caller). */
  interruptAllMembers(partyId?: string, exclude?: string): PartyCommandResult & { interrupted: string[]; idle: string[] } {
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const party = this.requireParty(state, partyId);
    const interrupted: string[] = [];
    const idle: string[] = [];
    for (const member of this.membersOf(state, party.id)) {
      if (exclude && member.name === exclude) {
        continue;
      }
      if (member.sessionId && this.deps.sessionManager.hasSession(member.sessionId) && this.isSessionBusy(member.sessionId)) {
        this.deps.sessionManager.interrupt(member.sessionId);
        interrupted.push(member.name);
      } else {
        idle.push(member.name);
      }
    }
    log("info", "party", "party-wide interrupt requested", { partyId: party.id, interrupted, exclude });
    return { ...this.result(`Interrupt requested for ${interrupted.length} member(s).`, state, undefined, party.id), interrupted, idle };
  }

  /**
   * Sends one message to every member of the party except the sender. Each
   * delivery goes through {@link sendGatedMessage} (Message Gate review + same
   * routing/persistence/optional interrupt); per-member failures — including a
   * gate rejection — are collected, never silently dropped.
   */
  async broadcastMessage(content: string, from = "user", partyId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }): Promise<PartyCommandResult & { delivered: string[]; queuedMembers: string[]; failed: Array<{ name: string; error: string }> }> {
    if (!content.trim()) {
      throw new Error("broadcast requires a non-empty content.");
    }
    const initial = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const party = this.requireParty(initial, partyId);
    const targets = this.membersOf(initial, party.id).filter((member) => member.name !== from);
    if (!targets.length) {
      throw new Error("No other members in the party to broadcast to.");
    }
    const delivered: string[] = [];
    // A member that was busy has the message WAITING, not lost. Reporting that
    // as `failed` would tell the sender its message never arrived and invite a
    // duplicate resend, so queued members get their own bucket.
    const queuedMembers: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const target of targets) {
      try {
        const result = await this.sendGatedMessage(target.name, content, from, undefined, party.id, options);
        if (result.queued) {
          queuedMembers.push(target.name);
        } else if (result.partyMessage?.delivered) {
          delivered.push(target.name);
        } else {
          failed.push({ name: target.name, error: result.partyMessage?.error || "not_delivered" });
        }
      } catch (error) {
        failed.push({ name: target.name, error: errorMessage(error) });
      }
    }
    log("info", "party", "broadcast routed", { partyId: party.id, from, delivered, queued: queuedMembers, failed: failed.map((f) => f.name), interrupt: options?.interrupt ?? "inherited" });
    const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
    const reach = queuedMembers.length ? `${delivered.length} delivered, ${queuedMembers.length} queued` : `${delivered.length}`;
    return { ...this.result(`Broadcast reached ${reach}/${targets.length} member(s).`, state, undefined, party.id), delivered, queuedMembers, failed };
  }

  private turnStatusOf(member: PartyMember): Record<string, unknown> {
    const view = this.sessionViewOf(member.sessionId);
    // `sleeping` is reported as itself rather than collapsing into "not_started".
    // Agents read this to decide whether a teammate can be given work, and
    // "not started" invites the wrong repair — a duplicate member-create — for a
    // member that is one message away from carrying on its existing conversation.
    const status = view
      ? String(view.snapshot.status)
      : member.status === "sleeping" ? "sleeping" : member.sessionId ? "missing_session" : "not_started";
    return {
      name: member.name,
      // A session entry outlives its harness, so "we hold a session object" is
      // not the same claim as "this member is running" — reporting it as such
      // told agents a dead member was available to receive work. Uses the
      // adapter's own liveness rather than a status string, which only ever
      // described Claude (#21).
      running: Boolean(view) && view?.snapshot.harnessAlive !== false,
      turnActive: Boolean(view && BUSY_SESSION_STATUSES.has(status)),
      status,
      turnCount: view?.snapshot.turnCount,
      pendingApprovalCount: view?.snapshot.pendingApprovalCount,
      model: view?.snapshot.model ?? member.model,
    };
  }

  private sessionViewOf(sessionId?: string): SessionView | undefined {
    if (!sessionId) {
      return undefined;
    }
    return this.deps.sessionManager.listSessions().find((session) => session.id === sessionId);
  }

  private isSessionBusy(sessionId?: string): boolean {
    if (!sessionId) return false;
    // Older test doubles predate the lifecycle method; production always uses
    // SessionManager's exact flag. The fallback keeps isolated legacy fixtures
    // meaningful without weakening the real routing decision.
    const active = this.deps.sessionManager.isTurnActive?.(sessionId);
    if (typeof active === "boolean") return active;
    const view = this.sessionViewOf(sessionId);
    return Boolean(view && BUSY_SESSION_STATUSES.has(String(view.snapshot.status)));
  }

  private applyRuntimeDefaults(member: PartyMember, input: StartPartyMemberInput): void {
    if (input.permissionMode !== undefined && !isPermissionModeSetting(input.permissionMode)) {
      throw new Error(`Unknown Claude permission mode '${input.permissionMode}'.`);
    }
    const requestedCodexPolicy = input.codexPolicy === undefined ? undefined : requireCodexPolicy(input.codexPolicy);
    const requestedCursorPolicy = input.cursorPolicy === undefined ? undefined : requireCursorPolicy(input.cursorPolicy);
    if (input.selectedHarnessId) {
      const requested = normalizeHarnessId(input.selectedHarnessId);
      if (requested !== normalizeHarnessId(member.runtime)) {
        if (this.memberHasStartedTurn(member)) {
          throw new Error(`Cannot change harness for '${member.name}' after its first turn has started.`);
        }
        member.runtime = requested;
        member.harnessSessionId = undefined;
      }
    }
    // Fill unset fields from the member's own harness defaults (not one global).
    const defaults = harnessDefaultsOf(getSettings(), normalizeHarnessId(member.runtime));
    member.model = input.model || member.model || defaults.model;
    member.effort = input.effort || member.effort || defaults.effort;
    const harnessId = normalizeHarnessId(member.runtime);
    if (harnessId === "cursor") {
      member.cursorPolicy = cursorPolicyOf(
        requestedCursorPolicy || member.cursorPolicy || defaults.cursorPolicy,
        input.permissionMode || member.permissionMode || defaults.permissionMode,
      );
      member.permissionMode = undefined;
    } else {
      member.permissionMode = input.permissionMode || member.permissionMode || defaults.permissionMode;
    }
    member.reasoning = input.thinking || member.reasoning || defaults.reasoning;
    member.reasoningBudget = input.thinkingBudget ?? member.reasoningBudget ?? defaults.reasoningBudget;
    member.serviceTier = input.serviceTier ?? member.serviceTier ?? defaults.serviceTier;
    if (harnessId === "codex") {
      const executionDefaults = harnessDefaultsOf(getSettings(), "codex");
      member.codexPolicy = {
        ...(requestedCodexPolicy
          ? requestedCodexPolicy
          : member.codexPolicy || executionDefaults.codexPolicy || DEFAULT_CODEX_POLICY),
      };
    } else {
      member.codexPolicy = undefined;
    }
    if (harnessId !== "cursor") {
      member.cursorPolicy = undefined;
    }
  }

  /** Live turn count wins; persisted transcript keeps the lock after restart. */
  private memberHasStartedTurn(member: PartyMember): boolean {
    const snapshot = this.sessionViewOf(member.sessionId)?.snapshot;
    if ((snapshot?.turnCount || 0) > 0 || Boolean(snapshot?.lastUserMessageAt)) {
      return true;
    }
    const blocks = this.repository.readTranscript(this.workspacePath(), this.partyIdOf(member), member.name);
    return blocks.some((block: any) => block?.kind === "user" || block?.kind === "assistant");
  }

  private createMemberSession(
    workspace: string,
    member: PartyMember,
    input: StartPartyMemberInput,
    options: { mock?: boolean; autoReply?: boolean },
  ): SessionView {
    const createInput = {
      workspacePath: workspace,
      selectedHarnessId: normalizeHarnessId(member.runtime),
      selectedProviderId: input.selectedProviderId,
      model: member.model,
      effort: member.effort as any,
      thinking: member.reasoning,
      thinkingBudget: member.reasoningBudget,
      serviceTier: member.serviceTier,
      permissionMode: member.permissionMode,
      codexPolicy: member.codexPolicy,
      cursorPolicy: member.cursorPolicy,
    };
    if (options.mock) {
      // Attribute mock turns to the member too, so the usage ledger / dashboard
      // works under QA (and in design captures) exactly as with a live member.
      return this.deps.sessionManager.createMockSession(createInput, {
        autoReply: options.autoReply,
        identity: { party: this.partyIdOf(member), member: member.name, role: member.role },
      });
    }
    // Give the member's session the in-process party tool surface, with its
    // identity closure-bound so `from` is never agent-supplied.
    const binding: SessionPartyBinding = {
      bridge: this.partyBridgeFor(this.partyIdOf(member), member.name),
      identity: { party: this.partyIdOf(member), member: member.name, role: member.role },
    };
    // Resume the harness's own thread when we have one, so reopening the member
    // (or the app) continues the conversation with its model context intact.
    return this.deps.sessionManager.createSession(createInput, member.harnessSessionId || undefined, binding);
  }

  private ensureMigrated(state: StoredPartyState): StoredPartyState {
    this.healMemberModels(state);
    this.reconcileStaleSessionBindings(state);
    for (const member of state.members) {
      if (normalizeHarnessId(member.runtime) === "cursor" && !member.cursorPolicy) {
        member.cursorPolicy = cursorPolicyOf(undefined, member.permissionMode);
        member.permissionMode = undefined;
        log("info", "party", "migrated legacy Cursor permission", { member: member.name, cursorPolicy: member.cursorPolicy });
      }
    }
    if (state.parties.length > 0) {
      return state;
    }
    if (state.members.length === 0) {
      return state;
    }
    const now = new Date().toISOString();
    const party: PartyDefinition = { id: "default", name: "Default Party", createdAt: now, updatedAt: now };
    return {
      ...state,
      parties: [party],
      currentPartyId: party.id,
      members: state.members.map((member) => ({ ...member, partyId: party.id })),
      messages: state.messages.map((message) => ({ ...message, partyId: party.id })),
    };
  }

  /** Already-logged stale bindings, so the read-path reconcile logs each once. */
  private readonly reportedStaleBindings = new Set<string>();

  /**
   * Clears session bindings whose OWNING PROCESS is gone. The app session id is
   * per-process, but the store is shared and survives quits/crashes — nothing
   * used to invalidate it, so members kept a dead `sessionId` + `status:
   * "running"` forever and read as `missing_session` ghosts. A binding is kept
   * only while its recorded boot is this process (and the session is live) or
   * another still-running process on this host (same-host pid probe — the store
   * and its engines always share a host; see the WSL remote-engine design). Runs on every
   * state read (deterministic, in-memory); the next mutation persists it.
   */
  private reconcileStaleSessionBindings(state: StoredPartyState): void {
    for (const member of state.members) {
      if (!member.sessionId || this.deps.sessionManager.hasSession(member.sessionId)) {
        continue;
      }
      if (sessionOwnerMayBeAlive(member.sessionBootId)) {
        continue;
      }
      const key = `${member.partyId}/${member.name}/${member.sessionId}`;
      if (!this.reportedStaleBindings.has(key)) {
        this.reportedStaleBindings.add(key);
        log("info", "party", "cleared stale session binding (owner process gone)", {
          member: member.name,
          partyId: member.partyId,
          sessionId: member.sessionId,
          sessionBootId: member.sessionBootId,
        });
      }
      member.sessionId = undefined;
      member.sessionBootId = undefined;
      if (member.status === "running" || member.status === "missing_session") {
        member.status = "idle";
      }
    }
  }

  /**
   * Rewrites a member's persisted model to its catalog id when it was stored
   * under a different spelling of the SAME Anthropic model — e.g. the
   * OpenRouter slug "anthropic/claude-opus-5" or the retired short alias
   * "opus[1m]" instead of "claude-opus-5[1m]". Such a value inferred provider
   * "custom" and silently routed a subscription model through the router →
   * OpenRouter (token-billed), and the Runtime modal lost the model's
   * capabilities (the vanished thinking/Adaptive control). Healed in memory on
   * every read (persists with the next write); logged, never silent. Non-
   * Anthropic ids are left alone — codex members legitimately store slugs.
   */
  private healMemberModels(state: StoredPartyState): void {
    for (const member of state.members) {
      if (!member.model || member.runtime === "codex") {
        continue;
      }
      const entry = resolveCatalogModel(member.model);
      if (entry && entry.provider === "anthropic" && member.model !== entry.id) {
        log("warn", "party", "healed member model spelling", { member: member.name, from: member.model, to: entry.id });
        member.model = entry.id;
      }
    }
  }

  /**
   * Builds a command result. The returned view is scoped to `viewPartyId` when
   * given, else to the acted-on member's OWN party (so a member op reflects the
   * party that member lives in), else the default. This keeps the payload a
   * caller/window receives aligned with the party it is operating on.
   */
  private result(message: string, state: StoredPartyState, member?: PartyMember, viewPartyId?: string): PartyCommandResult {
    const view = this.view(state, viewPartyId ?? (member ? this.partyIdOf(member) : undefined));
    return { ok: true, message, ...view, member: member ? this.withLiveStatus(member) : undefined };
  }

  private view(state: StoredPartyState, viewPartyId?: string): { parties: PartyDefinition[]; currentPartyId?: string; members: PartyMember[]; messages: PartyMessage[] } {
    const currentPartyId = this.resolvePartyId(state, viewPartyId);
    return {
      parties: state.parties,
      currentPartyId,
      members: state.members.filter((member) => member.partyId === currentPartyId).map((member) => this.withLiveStatus(member)),
      messages: state.messages.filter((message) => message.partyId === currentPartyId),
    };
  }

  /**
   * Resolves a party. An EXPLICIT id must name a real party (no silent fall-back
   * to the first party — a bad id surfaces as an error). With no id, resolves the
   * advisory default (hint, else first) — a genuine default, not a masked error.
   * NO side effects: the caller's window owns "which party is active", so this
   * never mutates shared state (that made two windows track each other).
   */
  private requireParty(state: StoredPartyState, explicitPartyId?: string): PartyDefinition {
    if (explicitPartyId) {
      const party = state.parties.find((item) => item.id === explicitPartyId);
      if (!party) {
        throw new Error(`Party '${explicitPartyId}' does not exist.`);
      }
      return party;
    }
    const activeId = this.resolvePartyId(state);
    const party = state.parties.find((item) => item.id === activeId);
    if (!party) {
      throw new Error("Create a party before creating members or sessions.");
    }
    return party;
  }

  private requireMember(state: StoredPartyState, name: string, partyId?: string): PartyMember {
    const party = this.requireParty(state, partyId);
    const normalized = normalizeMemberName(name);
    const member = state.members.find((item) => item.partyId === party.id && item.name === normalized);
    if (!member) {
      throw new Error(`Party member '${normalized || name}' does not exist in '${party.name}'.`);
    }
    return member;
  }

  /**
   * The member's status as it actually is, not as the bookkeeping remembers it.
   *
   * "Running" used to mean nothing more than "an entry exists in the in-memory
   * session map". The map keeps that entry after the harness process is gone —
   * the adapter reports `closed` when its stream ends, and nothing removed it —
   * so a member whose harness had died still read as running, and the UI offered
   * it as ready to chat (#13). The adapter's own last report is the honest
   * source, and the codebase already treats this exact signal as death for the
   * background usage adapters ({@link SessionManager} `bind`/usage handlers);
   * member sessions were the ones missing the rule.
   *
   * Reported through the EXISTING `missing_session` value rather than a new one:
   * the binding is still there, the harness behind it is not.
   */
  private withLiveStatus(member: PartyMember): PartyMember {
    if (!member.sessionId) {
      return member;
    }
    if (this.deps.sessionManager.hasSession(member.sessionId) && !this.harnessIsGone(member.sessionId)) {
      return { ...member, status: "running" };
    }
    return { ...member, status: "missing_session" };
  }

  /**
   * Whether the session's harness can no longer serve turns.
   *
   * Asks the adapter for the fact instead of matching a status string. Only
   * Claude ever writes `"closed"`, so the string test reported Codex and Cursor
   * members as alive whatever had happened to them — and a Codex app-server
   * that exits while IDLE changes no status at all, so nothing could have been
   * matched (#21).
   */
  private harnessIsGone(sessionId: string): boolean {
    const snapshot = this.sessionViewOf(sessionId)?.snapshot;
    return snapshot ? snapshot.harnessAlive === false : false;
  }




  private writeRoleFile(workspace: string, member: PartyMember, initialTask?: string): void {
    const dir = this.repository.memberDir(workspace, this.partyIdOf(member), member.name);
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      `# ${member.name}`,
      "",
      `Party: ${this.partyIdOf(member)}`,
      `Runtime: ${member.runtime || "claude-code"}`,
      `Role: ${member.role || ""}`,
      "",
      "Session cwd must remain the project root. This file is role context only, not a working directory.",
      initialTask ? `\nInitial task:\n${initialTask.trim()}\n` : "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "MEMBER.md"), content);
  }

  // --- Party bridge (Boundary 2 of the party-communication design) -------------
  // The in-process capability surface handed to a member's session. Every method
  // routes through the same service methods the UI/HTTP use, never throws (tool
  // handlers stay trivial), and re-broadcasts party state so the UI updates.
  // `from` is closure-bound to the calling member; every operation is scoped to
  // the caller's OWN party (`party`), never a shared/default one — an agent's
  // party tools must act inside its party regardless of what any window is viewing.
  /**
   * Runs one party tool ON BEHALF OF a member that reaches us over HTTP instead
   * of in-process — today, a Codex member, whose tools live in a separate stdio
   * MCP server (`scripts/agentparty-codex-mcp-server.mjs`).
   *
   * It exists so that transport is the ONLY difference between harnesses. That
   * server used to call the same REST endpoints the UI uses and hand the answer
   * back raw, which meant the agent-facing contract was written twice — and the
   * two copies had already drifted apart:
   *
   * - a message the gate REJECTED came back as `ok: true`, with the refusal
   *   buried in a `message` field, so a Codex member was told its message was
   *   delivered when it was not;
   * - every call returned the UI's whole command result — the party list, every
   *   member record and up to 200 messages. Measured on a real party: 297KB,
   *   roughly 74,000 tokens, per `send`. The correct answer is 36 bytes.
   *
   * `invokePartyTool` is the one place that decides what a tool returns, so both
   * harnesses now go through it and there is no second copy to drift.
   */
  async invokePartyToolAs(member: string, tool: string, args: unknown, partyId?: string): Promise<PartyToolResult> {
    const state = this.repository.read(this.workspacePath());
    const caller = state.members.find((m) => m.name === member && (!partyId || m.partyId === partyId));
    if (!caller) {
      return { ok: false, error: `Member '${member}' is not in this party.` };
    }
    const party = this.partyIdOf(caller);
    return invokePartyTool(this.partyBridgeFor(party, caller.name), { party, member: caller.name, role: caller.role }, tool, args);
  }

  private partyBridgeFor(party: string, selfMember: string): PartyBridge {
    const notify = () => this.deps.sessionManager.notifyPartyChanged(this.workspacePath());
    return {
      send: async (from, to, content, interrupt, force, forceReason) => {
        try {
          const result = await this.sendGatedMessage(to, content, from || selfMember, undefined, party, { interrupt, force, forceReason });
          notify();
          // Queued is success: the message is waiting in the app queue and will
          // be handed over on the idle drain. Reporting failure here made agents
          // (and anything that retries on !ok) duplicate a message that was
          // already safely parked — the same class of bug #22 fixed for broadcast.
          if (result.queued || result.partyMessage?.error === "queued_for_busy_member") {
            return { ok: true, data: { queued: true } };
          }
          if (!result.partyMessage?.delivered) {
            // A gate rejection carries its reason in `error` — surface it verbatim
            // so the sender can rewrite; else the generic "not running" hint.
            return { ok: false, error: result.partyMessage?.error || `Member '${to}' is not running. Start it (or member-create it) before sending.` };
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      createMember: async (request) => {
        const harness = String(request.harness || "claude-code").toLowerCase() as HarnessId;
        // Validate against the canonical harness list — a hardcoded copy here
        // silently rejected 'grok' for weeks after the harness shipped.
        if (!HARNESS_IDS.includes(harness)) {
          return { ok: false, error: `Unknown harness '${request.harness}'. Use ${HARNESS_IDS.map((id) => `'${id}'`).join(", ")}.` };
        }
        if (request.permissionMode !== undefined && !isPermissionModeSetting(request.permissionMode)) {
          return { ok: false, error: `Unknown Claude permission mode '${request.permissionMode}'.` };
        }
        try {
          this.createMember({
            partyId: party,
            name: request.name,
            requirement: request.role,
            role: request.role,
            runtime: harness,
            model: request.model,
            effort: request.effort,
            reasoning: request.reasoning,
            reasoningBudget: request.reasoningBudget,
            serviceTier: request.serviceTier,
            permissionMode: request.permissionMode,
            codexPolicy: request.codexPolicy,
            cursorPolicy: request.cursorPolicy,
          });
          const started = this.startMember(request.name, {}, {}, party);
          notify();
          return { ok: true, data: { ok: true, name: request.name, status: started.member?.status ?? "running" } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      removeMember: async (name) => {
        try {
          this.removeMember(name, party);
          notify();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      setPermission: async (name, request) => {
        if (request.permissionMode !== undefined && !isPermissionModeSetting(request.permissionMode)) {
          return { ok: false, error: `Unknown Claude permission mode '${request.permissionMode}'.` };
        }
        try {
          const result = this.setMemberPermission(name, {
            permissionMode: request.permissionMode,
            codexPolicy: request.codexPolicy,
            cursorPolicy: request.cursorPolicy,
          }, party);
          notify();
          return {
            ok: true,
            data: {
              ok: true,
              name,
              permissionMode: result.member?.permissionMode,
              codexPolicy: result.member?.codexPolicy,
              cursorPolicy: result.member?.cursorPolicy,
            },
          };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      gateSet: async (name, patch) => {
        try {
          const result = this.setMemberGate(name, patch, party);
          notify();
          const state = this.readState();
          const member = result.member ? this.effectiveGateOf(result.member, state) : undefined;
          return { ok: true, data: { ok: true, name, gate: member } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      partyGateSet: async (patch) => {
        try {
          // Merge onto the CURRENT party gate: the patch carries only the axes
          // the agent named, and setPartyGate persists a whole gate.
          const current = this.readState().parties?.find((item) => item.id === party)?.gate;
          const next = {
            enabled: typeof patch.enabled === "boolean" ? patch.enabled : current?.enabled ?? false,
            rule: typeof patch.rule === "string" ? patch.rule : current?.rule ?? "",
            ...(patch.reviewer === null
              ? {}
              : patch.reviewer
                ? { reviewer: patch.reviewer }
                : current?.reviewer
                  ? { reviewer: current.reviewer }
                  : {}),
          };
          const result = this.setPartyGate(party, next);
          notify();
          const gate = this.readState().parties?.find((item) => item.id === party)?.gate;
          return { ok: true, data: { ok: result.ok, partyId: party, gate } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      list: async () => {
        const state = this.readState();
        const members = state.members
          .filter((member) => this.partyIdOf(member) === party)
          .map((member) => this.withLiveStatus(member))
          .map((member) => ({
            name: member.name,
            role: member.role ?? "",
            status: member.status,
            harness: member.runtime ?? "claude-code",
            executionHarness: normalizeHarnessId(member.runtime),
            model: member.model ?? "",
            permissionMode: member.permissionMode,
            codexPolicy: member.codexPolicy,
            // The effective Message Gate so a member editing another's gate can
            // read its current on/off + rule + reviewer.
            gate: this.effectiveGateOf(member, state),
          }));
        return { ok: true, data: { members } };
      },
      listModels: async () => ({ ok: true, data: partyModelDiscovery(this.deps.sessionManager.getCodexModelState()) }),
      status: async (name) => {
        try {
          return { ok: true, data: { members: this.memberTurnStatus(name, party).members } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      interrupt: async (target) => {
        // Self-interrupt would abort the very turn executing this tool call.
        if (target === selfMember) {
          return { ok: false, error: "You cannot interrupt yourself. Target another member, or 'all' (which excludes you)." };
        }
        try {
          if (target === "all" || target === "*") {
            const result = this.interruptAllMembers(party, selfMember);
            notify();
            return { ok: true, data: { interrupted: result.interrupted, idle: result.idle } };
          }
          const result = this.interruptMember(target, party);
          notify();
          return { ok: true, data: { interrupted: result.interrupted ? [target] : [], idle: result.interrupted ? [] : [target] } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      broadcast: async (content, interrupt) => {
        try {
          const result = await this.broadcastMessage(content, selfMember, party, { interrupt });
          notify();
          // `queuedMembers` is reported apart from BOTH: those members will get
          // the message when their current turn ends. Folding them into `failed`
          // would prompt the sending agent to send a duplicate.
          return { ok: true, data: { delivered: result.delivered, queuedMembers: result.queuedMembers, failed: result.failed } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      // Discord tools act on the CALLER only — `selfMember` is closure-bound, so
      // there is no member argument an agent could point at someone else.
      discordConnect: async (channelName) => {
        const discord = this.deps.discord;
        if (!discord) {
          return { ok: false, error: "The Discord bridge is not available in this process." };
        }
        try {
          const result = await discord.connectMember({
            workspacePath: this.workspacePath(),
            party,
            // The channel is named after the party the user SEES, not its id.
            partyLabel: this.partyLabelOf(party),
            member: selfMember,
            channelName,
          });
          return { ok: true, data: { channel: result.channelName, thread: result.threadName, created: result.created } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      discordSend: async (content) => {
        const discord = this.deps.discord;
        if (!discord) {
          return { ok: false, error: "The Discord bridge is not available in this process." };
        }
        try {
          const result = await discord.sendAsMember(this.workspacePath(), party, selfMember, content);
          return { ok: true, data: { channel: result.channelName } };
        } catch (error) {
          // Rate limits and the length rejection both land here; the message
          // carries what the agent must do next (wait N ms / split the text).
          return { ok: false, error: errorMessage(error) };
        }
      },
      discordSendImage: async (imagePath, caption) => {
        const discord = this.deps.discord;
        if (!discord) {
          return { ok: false, error: "The Discord bridge is not available in this process." };
        }
        // The file is read HERE, in the process the member runs in: a WSL member's
        // path exists only inside the distro, while the bridge (and the token) live
        // on the desktop. Only the decoded bytes cross that boundary.
        let image: { dataBase64: string; filename: string; mediaType: string };
        try {
          image = readImageFile(imagePath);
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
        try {
          const result = await discord.sendImageAsMember(this.workspacePath(), party, selfMember, image, caption);
          return { ok: true, data: { channel: result.channelName } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      attachImage: async ({ path: imagePath, url, caption }) => {
        // A URL is kept as given rather than downloaded, so it renders from its
        // own source and nothing has to be retained for it.
        if (url) {
          if (!/^https?:\/\//i.test(url)) {
            return { ok: false, error: "attach-image url must start with http:// or https://." };
          }
          return { ok: true, data: { url, caption } };
        }
        // Read HERE, in the process the member runs in: a WSL member's path
        // exists only inside the distro. Only the decoded bytes cross.
        let image: { dataBase64: string; filename: string; mediaType: string };
        try {
          image = readImageFile(String(imagePath));
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
        if (base64ByteLength(image.dataBase64) > DEFAULT_MAX_IMAGE_BYTES) {
          return { ok: false, error: `'${image.filename}' is larger than the ${Math.round(DEFAULT_MAX_IMAGE_BYTES / (1024 * 1024))} MB limit for an attached image.` };
        }
        try {
          // STORED, not returned. The tool result is part of the model's
          // conversation, so the bytes must not ride back in it — the card
          // exists precisely so the picture stays out of the context.
          const stored = this.repository.storeImage(this.workspacePath(), image.dataBase64, image.mediaType);
          return { ok: true, data: { file: stored.file, mediaType: stored.media_type, bytes: stored.bytes, caption } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      discordDisconnect: async () => {
        const discord = this.deps.discord;
        if (!discord) {
          return { ok: false, error: "The Discord bridge is not available in this process." };
        }
        try {
          return { ok: true, data: await discord.disconnectMember(this.workspacePath(), party, selfMember) };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    };
  }

  private workspacePath(): string {
    return this.deps.getWorkspacePath() || process.cwd();
  }

  /** The party's display name (falls back to its id when it cannot be resolved). */
  partyLabelOf(partyId: string): string {
    return this.list().parties.find((party) => party.id === partyId)?.name || partyId;
  }
}

/**
 * The rich harness + model catalog returned by the `list-models` party tool, so
 * an agent can fill `member-create` correctly (each model states its harness).
 * Reads the same catalog (`buildModelRoutes`) the UI and routing use, including
 * the live Codex account catalog when discovered; a discovery failure rides
 * along as `codexModelsError` instead of being dropped.
 */
function partyModelDiscovery(codexModels?: CodexModelDiscoveryState): {
  harnesses: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  codexModelsError?: string;
} {
  const settings = getSettings();
  const routes = buildModelRoutes(harnessDefaultsOf(settings).model, [], [], codexModels?.models);
  return {
    harnesses: harnesses.map((harness) => {
      return {
        id: harness.id,
        label: harness.label,
        status: harness.status,
        permission: permissionDiscoveryFor(settings, harness.id),
      };
    }),
    codexModelsError: codexModels?.status === "error" ? codexModels.error : undefined,
    models: routes.map((route) => {
      const thinking = route.capabilities.thinking;
      const effort = route.capabilities.effort;
      const serviceTier = route.capabilities.serviceTier;
      const reasoning = thinking.supported || effort.supported
        ? {
            effort: effort.supported ? { options: effort.options.map((option) => option.id), default: effort.defaultValue } : undefined,
            thinking: thinking.supported && thinking.modes ? { modes: thinking.modes.map((mode) => mode.id), default: thinking.defaultValue } : undefined,
            budget: thinking.supported ? thinking.budget : undefined,
          }
        : null;
      return {
        id: route.model,
        label: route.label,
        harness: route.harnessId,
        executionHarness: route.harnessId || "claude-code",
        provider: route.providerId,
        perf: route.meta?.perf,
        costTier: route.meta?.costTier,
        inPerM: route.meta?.inPerM,
        outPerM: route.meta?.outPerM,
        ioPerM: route.meta?.ioPerM,
        context: route.meta?.context,
        reasoning,
        serviceTier: serviceTier?.supported
          ? { options: serviceTier.options.map((option) => option.id), default: serviceTier.defaultValue }
          : null,
      };
    }),
  };
}

/**
 * This process's session-ownership stamp, recorded next to every sessionId it
 * writes into the shared party store (see PartyMember.sessionBootId). The pid
 * lets another process on the same host probe whether the owner is still
 * running; the nonce distinguishes recycled pids across boots.
 */
export const SESSION_BOOT_ID = `boot-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Whether the process that recorded `bootId` may still be running (same-host
 * pid probe). `false` means the binding is certainly stale: no owner recorded
 * (legacy/pre-crash), our own boot without a live session, a recycled pid, or
 * a pid that no longer exists. EPERM counts as alive — the process exists but
 * belongs to another user.
 */
function sessionOwnerMayBeAlive(bootId: string | undefined): boolean {
  if (!bootId || bootId === SESSION_BOOT_ID) {
    return false;
  }
  const pid = Number(bootId.split("-")[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Image types Discord renders inline and every vision model accepts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Reads an image file for `discord-send-image`, in the process the member runs
 * in. Every rejection states what is wrong so the agent can fix it instead of
 * retrying blindly: a missing file, a directory, an unsupported extension.
 */
function readImageFile(filePath: string): { dataBase64: string; filename: string; mediaType: string } {
  const resolved = path.resolve(filePath);
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved).toLowerCase()];
  if (!mediaType) {
    throw new Error(`'${filePath}' is not a supported image (png, jpg, gif, webp). Nothing was sent.`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`No such file: '${resolved}'. Note the path must exist on the machine YOU run on.`);
  }
  if (!stat.isFile()) {
    throw new Error(`'${resolved}' is not a file.`);
  }
  return { dataBase64: fs.readFileSync(resolved).toString("base64"), filename: path.basename(resolved), mediaType };
}
