import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CreateMemberInput,
  CreatePartyInput,
  PartyCommandResult,
  PartyDefinition,
  PartyMember,
  PartyMessage,
  StartPartyMemberInput,
  SessionView,
} from "../../shared/types";
import { harnessDefaultsOf, isPermissionModeSetting } from "../../shared/types";
import type { ImageAttachment } from "../../shared/attachments";
import { log } from "../logger";
import { PartyRepository, StoredPartyState } from "../partyRepository";
import { getSettings } from "../settings";
import type { SessionManager, SessionPartyBinding } from "../sessionManager";
import type { PartyBridge } from "../../core/partyBridge";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import { buildModelRoutes } from "../../core/modelRegistry";
import { harnesses } from "../harness/types";
import {
  buildChannelPayload,
  buildPartyMember,
  createPartyDefinition,
  createPartyMessage,
  errorMessage,
  normalizeHarnessId,
  normalizeMemberName,
} from "./partyDomain";

export interface PartyApplicationDeps {
  sessionManager: SessionManager;
  getWorkspacePath: () => string;
}

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

  constructor(private readonly deps: PartyApplicationDeps) {}

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

  startMember(name: string, input: StartPartyMemberInput = {}, options: { mock?: boolean; autoReply?: boolean } = {}, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    this.applyRuntimeDefaults(member, input);
    const session = this.createMemberSession(workspace, member, input, options);
    member.sessionId = session.id;
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
   * Sends a user turn to a member — the SINGLE path behind both the UI Send
   * button and the HTTP API, so an agent drives the exact same route a user
   * does. Idempotently ensures the member has a live session (starting it with
   * the member's own persisted config when absent — never a duplicate when one
   * is already active), then delivers the raw user turn plus any image
   * attachments. Distinct from {@link sendMessage}, which wraps inter-member
   * channel messages.
   */
  sendUserMessage(name: string, text: string, attachments?: ImageAttachment[], partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    let session: SessionView | undefined;
    let sessionId = member.sessionId && this.deps.sessionManager.hasSession(member.sessionId) ? member.sessionId : undefined;
    if (!sessionId) {
      const started = this.startMember(member.name, {}, {}, this.partyIdOf(member));
      session = started.session;
      sessionId = session?.id;
    }
    if (!sessionId) {
      throw new Error(`Could not start a session for member '${member.name}'.`);
    }
    this.deps.sessionManager.sendUserTurn(sessionId, text, attachments);
    // Re-read: startMember wrote the new sessionId/status; reflect it back.
    const fresh = this.ensureMigrated(this.repository.read(workspace));
    const target = this.requireMember(fresh, member.name, this.partyIdOf(member));
    log("info", "party", "user turn sent", { workspace, partyId: target.partyId, member: target.name, sessionId, images: attachments?.length || 0 });
    return { ...this.result(`Message sent to '${target.name}'.`, fresh, target), session };
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
   * Persists a member's transcript to disk (called debounced by the renderer, the
   * transcript's assembler). Also captures the member's live harness thread id so
   * a later reopen resumes that thread — keeping the record and the model context.
   */
  saveMemberTranscript(name: string, blocks: unknown[], partyId?: string): void {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    this.repository.writeTranscript(workspace, this.partyIdOf(member), member.name, blocks);
    const harnessId = member.sessionId ? this.deps.sessionManager.harnessSessionId(member.sessionId) : undefined;
    if (harnessId && harnessId !== member.harnessSessionId) {
      member.harnessSessionId = harnessId;
      member.updatedAt = new Date().toISOString();
      this.persistParty(workspace, state, this.partyIdOf(member));
    }
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
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = state.members.find((item) => item.sessionId === sessionId);
    if (!member || member.permissionMode === permissionMode) {
      return;
    }
    member.permissionMode = permissionMode;
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member permission mode persisted", { workspace, partyId: member.partyId, member: member.name, permissionMode });
  }

  bindMember(name: string, sessionId: string, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (!this.deps.sessionManager.hasSession(sessionId)) {
      throw new Error(`Session '${sessionId}' is not active.`);
    }
    member.sessionId = sessionId;
    member.status = "running";
    member.updatedAt = new Date().toISOString();
    this.persistParty(workspace, state, this.partyIdOf(member));
    log("info", "party", "member bound to session", { workspace, partyId: member.partyId, member: member.name, sessionId });
    return this.result(`Member '${member.name}' bound to active session.`, state, member);
  }

  closeMember(name: string, partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name, partyId);
    if (member.sessionId) {
      this.deps.sessionManager.closeSession(member.sessionId);
    }
    member.sessionId = undefined;
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

  sendMessage(to: string, content: string, from = "user", attachments?: ImageAttachment[], partyId?: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const target = this.requireMember(state, to, partyId);
    const message = createPartyMessage(target, content, from);
    if (target.sessionId && this.deps.sessionManager.hasSession(target.sessionId)) {
      this.deps.sessionManager.sendUserTurn(target.sessionId, buildChannelPayload(message, target), attachments);
      message.delivered = true;
      target.status = "running";
    } else {
      message.error = "target_member_has_no_active_session";
      target.status = target.sessionId ? "missing_session" : "opened";
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

  private applyRuntimeDefaults(member: PartyMember, input: StartPartyMemberInput): void {
    // Fill unset fields from the member's own harness defaults (not one global).
    const defaults = harnessDefaultsOf(getSettings(), normalizeHarnessId(member.runtime));
    member.model = input.model || member.model || defaults.model;
    member.effort = input.effort || member.effort || defaults.effort;
    member.permissionMode = input.permissionMode || member.permissionMode || defaults.permissionMode;
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
      permissionMode: member.permissionMode,
      codexPolicy: member.codexPolicy,
    };
    if (options.mock) {
      return this.deps.sessionManager.createMockSession(createInput, { autoReply: options.autoReply });
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

  private withLiveStatus(member: PartyMember): PartyMember {
    if (member.sessionId && this.deps.sessionManager.hasSession(member.sessionId)) {
      return { ...member, status: "running" };
    }
    if (member.sessionId) {
      return { ...member, status: "missing_session" };
    }
    return member;
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

  // --- Party bridge (Boundary 2 of docs/PARTY_COMMUNICATION.md) -------------
  // The in-process capability surface handed to a member's session. Every method
  // routes through the same service methods the UI/HTTP use, never throws (tool
  // handlers stay trivial), and re-broadcasts party state so the UI updates.
  // `from` is closure-bound to the calling member; every operation is scoped to
  // the caller's OWN party (`party`), never a shared/default one — an agent's
  // party tools must act inside its party regardless of what any window is viewing.
  private partyBridgeFor(party: string, selfMember: string): PartyBridge {
    const notify = () => this.deps.sessionManager.notifyPartyChanged(this.workspacePath());
    return {
      send: async (from, to, content) => {
        try {
          const result = this.sendMessage(to, content, from || selfMember, undefined, party);
          notify();
          if (!result.partyMessage?.delivered) {
            return { ok: false, error: `Member '${to}' is not running. Start it (or member-create it) before sending.` };
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      createMember: async (request) => {
        const harness = String(request.harness || "claude-code").toLowerCase();
        if (harness !== "claude-code" && harness !== "codex") {
          return { ok: false, error: `Unknown harness '${request.harness}'. Use 'claude-code' or 'codex'.` };
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
            model: member.model ?? "",
          }));
        return { ok: true, data: { members } };
      },
      listModels: async () => ({ ok: true, data: partyModelDiscovery(this.deps.sessionManager.getCodexModelState()) }),
    };
  }

  private workspacePath(): string {
    return this.deps.getWorkspacePath() || process.cwd();
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
  harnesses: Array<{ id: string; label: string; status: string }>;
  models: Array<Record<string, unknown>>;
  codexModelsError?: string;
} {
  const routes = buildModelRoutes(harnessDefaultsOf(getSettings()).model, [], [], codexModels?.models);
  return {
    harnesses: harnesses.map((harness) => ({ id: harness.id, label: harness.label, status: harness.status })),
    codexModelsError: codexModels?.status === "error" ? codexModels.error : undefined,
    models: routes.map((route) => {
      const thinking = route.capabilities.thinking;
      const effort = route.capabilities.effort;
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
        provider: route.providerId,
        perf: route.meta?.perf,
        costTier: route.meta?.costTier,
        inPerM: route.meta?.inPerM,
        outPerM: route.meta?.outPerM,
        ioPerM: route.meta?.ioPerM,
        context: route.meta?.context,
        reasoning,
      };
    }),
  };
}
