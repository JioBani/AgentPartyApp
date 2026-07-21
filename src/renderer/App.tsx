import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, History, KeyRound, Maximize2, Minus, Moon, Settings, SlidersHorizontal, Sparkles, Sun, X } from "lucide-react";
import type { HarnessDefaults, InitialAppState, PartyCommandResult, PartyMember, SessionView } from "../shared/types";
import { defaultMemberProfileOf, harnessDefaultsOf } from "../shared/types";
import { shouldAutoCompact, type AutoCompactSetting } from "../shared/autoCompact";
import type { McpAuthResult, McpServerSnapshot } from "../shared/mcp";
import type { UsageLimitsSnapshot, UsageProviderId } from "../shared/usageLimits";
import { UsageLimitPill } from "./workbench/UsageLimitPill";
import { useTheme } from "./theme/ThemeProvider";
import { Workbench } from "./workbench/Workbench";
import type { WorkbenchActions } from "./workbench/actions";
import type { MemberView, Subagent, TranscriptBlock } from "./workbench/types";
import { buildMemberView } from "./workbench/memberStatus";
import { findRoute, RouteLike, routeKey } from "./workbench/routes";
import { displayPath, initialState, isViewId, MemberRuntimeDraft, ViewId, viewSubtitle, viewTitle } from "./app/appState";
import { AuthView, AutomationView, RuntimeSettingsView, SessionsView } from "./app/secondaryViews";
import { appendBlock, applyEvents, buildTranscriptSave, markApprovalResolved, nowTime, upsertSession } from "./app/transcriptEvents";
import { applySubagentEvents } from "./app/subagentEvents";

/**
 * Stable per-member identity for renderer-side caches (restored transcripts).
 * A member NAME alone is NOT unique — every party has a `main`, and a
 * delete+recreate reuses the same name. Keying by `(partyId, name, createdAt)`
 * isolates same-named members across parties (feedback #5: party-switch bleed)
 * and treats a recreated member as fresh (feedback #7: recreate keeps old
 * messages), while the on-disk store — already partitioned by (workspace, party,
 * member) — stays the source of truth.
 */
function memberKey(member: { partyId?: string; name: string; createdAt?: string }): string {
  return `${member.partyId || "default"}::${member.name}::${member.createdAt || ""}`;
}

export function App() {
  const theme = useTheme();
  const [state, setState] = useState<InitialAppState>(initialState);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [logsBySession, setLogsBySession] = useState<Record<string, TranscriptBlock[]>>({});
  // Subagents folded from `subagent` events, kept separate from the transcript so
  // their output never mixes into the main chat (rendered in the panel's dock).
  const [subagentsBySession, setSubagentsBySession] = useState<Record<string, Subagent[]>>({});
  // Persisted transcripts restored from disk, keyed by member name — shown for a
  // closed member or right after an app reopen (before/without a live session).
  const [restoredByMember, setRestoredByMember] = useState<Record<string, TranscriptBlock[]>>({});
  const [openRouterDraft, setOpenRouterDraft] = useState("");
  // Account/provider-scoped rate-limit usage (titlebar indicator). Global, pushed
  // by main; fetched once on mount and kept live via the "usage:update" channel.
  const [usageLimits, setUsageLimits] = useState<UsageLimitsSnapshot>({});
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  // Transient status/error line (session start failures, etc.), surfaced as a toast.
  const [partyNotice, setPartyNotice] = useState("");
  const [currentView, setCurrentView] = useState<ViewId>("workbench");
  // Sidebar open/closed persists across launches (README Electron note #6);
  // width is persisted separately in Workbench.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.localStorage.getItem("agentparty.sidebarOpen") !== "0");
  const [visibleMembers, setVisibleMembers] = useState<string[]>([]);
  const [seenLengths, setSeenLengths] = useState<Record<string, number>>({});
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<string, MemberRuntimeDraft>>({});
  // Members with a compaction in flight (transient toolbar spinner).
  const [compactingByMember, setCompactingByMember] = useState<Record<string, boolean>>({});
  const [layoutRequest, setLayoutRequest] = useState<{ panels: string[][]; nonce: number } | null>(null);
  // QA-driven "open this subagent's detail" request (mock-driven detail QA).
  const [subagentOpenRequest, setSubagentOpenRequest] = useState<{ member: string; subId: string; nonce: number } | null>(null);
  // Tracks whether a live party broadcast has arrived, so a late-resolving
  // initial-state load cannot clobber it with a stale snapshot.
  const partyBroadcastSeen = useRef(false);
  // Members with an in-flight session start, and members already prewarmed once.
  const startingRef = useRef<Set<string>>(new Set());
  // Auto-compact hysteresis: a member is "armed" while below its threshold; a
  // crossing fires ONE compaction and disarms it, re-arming only once occupancy
  // drops back below the threshold. This stops a member whose context can't be
  // reduced (Claude's "nothing to compact") from re-firing every snapshot.
  const autoArmedRef = useRef<Record<string, boolean>>({});

  const members = state.party.members;
  const sessions = state.sessions;
  const routes = state.modelRoutes as RouteLike[];
  // Live mirrors for the session-event handler (registered once) so it can seed a
  // resumed session's transcript from the member's restored history.
  const membersRef = useRef(members);
  membersRef.current = members;
  const restoredRef = useRef(restoredByMember);
  restoredRef.current = restoredByMember;

  // --- Transcript text zoom (Ctrl+wheel over a session view) ---------------
  const fontScale = state.settings.transcriptFontScale ?? 1;
  const fontScaleRef = useRef(fontScale);
  fontScaleRef.current = fontScale;
  const fontScalePersist = useRef<ReturnType<typeof setTimeout>>();

  // Reflect the zoom as a CSS variable every transcript reads (`zoom: var(...)`).
  useEffect(() => {
    document.documentElement.style.setProperty("--wb-font-scale", String(fontScale));
  }, [fontScale]);

  // Ctrl+wheel over a transcript grows/shrinks its text. Handled at the window
  // (non-passive) so we can preventDefault the browser's native ctrl+wheel zoom.
  // The value is a persisted, HTTP-drivable setting (survives restart), applied
  // locally at once for a responsive feel and persisted debounced.
  useEffect(() => {
    const MIN = 0.6;
    const MAX = 2.0;
    const STEP = 0.1;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".wb-transcript")) {
        return;
      }
      event.preventDefault();
      const delta = event.deltaY < 0 ? STEP : -STEP;
      const next = Math.round(Math.min(MAX, Math.max(MIN, fontScaleRef.current + delta)) * 100) / 100;
      if (next === fontScaleRef.current) {
        return;
      }
      fontScaleRef.current = next;
      setState((current) => ({ ...current, settings: { ...current.settings, transcriptFontScale: next } }));
      setPartyNotice(`글씨 크기 ${Math.round(next * 100)}%`);
      clearTimeout(fontScalePersist.current);
      fontScalePersist.current = setTimeout(() => { void window.agentParty.updateSettings?.({ transcriptFontScale: next }); }, 400);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const selectedParty = useMemo(
    () => (state.party.parties || []).find((party) => party.id === state.party.currentPartyId) || (state.party.parties || [])[0],
    [state.party.currentPartyId, state.party.parties],
  );

  const views = useMemo<MemberView[]>(
    () => members.map((member) => buildMemberView({
      member,
      sessions,
      transcriptBySession: logsBySession,
      subagentsBySession,
      seenCount: seenLengths[member.name] ?? 0,
      restored: restoredByMember[memberKey(member)],
      routes,
      compactDefault: state.settings.compactDefault,
      compacting: compactingByMember[member.name],
    })),
    [members, sessions, logsBySession, subagentsBySession, seenLengths, restoredByMember, routes, state.settings.compactDefault, compactingByMember],
  );

  // Auto-compaction trigger: when a member's live occupancy crosses its
  // threshold, fire ONE compaction (hysteresis via autoArmedRef so it never
  // loops on a context that can't shrink). Only when idle — we compact between
  // turns, not mid-response; the crossing stays latched until the turn ends.
  useEffect(() => {
    for (const view of views) {
      const { name } = view;
      const used = view.context?.used;
      const total = view.context?.total;
      const crossed = shouldAutoCompact(view.autoCompact, used, total);
      if (!crossed) {
        autoArmedRef.current[name] = true;
        continue;
      }
      const armed = autoArmedRef.current[name] !== false;
      if (armed && !view.busy && view.status !== "approval" && !view.compacting && sessionIdFor(name)) {
        autoArmedRef.current[name] = false;
        runCompact(name);
      }
    }
  }, [views]);

  useEffect(() => {
    void window.agentParty.getInitialState().then((next) => {
      // If a party broadcast already arrived, keep it (avoid the load race).
      setState((current) => (partyBroadcastSeen.current ? { ...next, party: current.party } : next));
      if (next.sessions?.[0]) {
        setActiveSessionId(next.sessions[0].id);
      }
    });

    const offEvents = window.agentParty.onSessionEvents((payload: any) => {
      setLogsBySession((current) => {
        let base = current;
        // First events for a freshly (re)started session: seed with the member's
        // restored history so a resumed conversation continues instead of blank.
        if (current[payload.sessionId] === undefined) {
          const member = membersRef.current.find((item) => item.sessionId === payload.sessionId);
          const restored = member ? restoredRef.current[memberKey(member)] : undefined;
          if (restored && restored.length) {
            base = { ...current, [payload.sessionId]: restored };
          }
        }
        return applyEvents(base, payload.sessionId, payload.events || []);
      });
      // Subagent events fold into their own slice (out of the transcript).
      setSubagentsBySession((current) => applySubagentEvents(current, payload.sessionId, payload.events || []));
    });
    const offSnapshot = window.agentParty.onSnapshot((payload: any) => {
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) => (
          session.id === payload.sessionId ? { ...session, snapshot: payload.snapshot } : session
        )),
      }));
    });
    const offSessions = window.agentParty.onSessions((payload) => {
      const next = payload as SessionView[];
      setState((current) => ({ ...current, sessions: next }));
      setActiveSessionId((current) => (current && next.some((session) => session.id === current) ? current : next[0]?.id || ""));
    });
    const offPartyUpdate = window.agentParty.onPartyUpdate((payload) => {
      const party = payload as InitialAppState["party"];
      partyBroadcastSeen.current = true;
      setState((current) => ({ ...current, party }));
    });
    // Codex catalog discovery settled: refresh the selectable model routes and
    // the discovery status (pending/ready/error) that pickers surface.
    const offModelsUpdate = window.agentParty.onModelsUpdate((payload) => {
      const update = payload as { modelRoutes?: unknown[]; codexModels?: InitialAppState["codexModels"] };
      if (Array.isArray(update?.modelRoutes)) {
        setState((current) => ({ ...current, modelRoutes: update.modelRoutes as unknown[], codexModels: update.codexModels }));
      }
    });
    const offQaLayout = window.agentParty.onQaLayout((payload) => {
      const panels = (payload as { panels?: string[][] })?.panels;
      if (Array.isArray(panels)) {
        setLayoutRequest({ panels, nonce: Date.now() });
        setCurrentView("workbench");
      }
    });
    const offQaOpenSub = window.agentParty.onQaOpenSubagent((payload) => {
      const { member, subId } = (payload as { member?: string; subId?: string }) || {};
      if (member && subId) {
        setSubagentOpenRequest({ member, subId, nonce: Date.now() });
        setCurrentView("workbench");
      }
    });
    // Settings are global; a change here or in another window / over HTTP pushes
    // the full settings. Preserve THIS window's own workspacePath on merge (each
    // window may view a different workspace).
    const offSettingsUpdate = window.agentParty.onSettingsUpdate?.((payload) => {
      const incoming = payload as InitialAppState["settings"];
      setState((current) => ({ ...current, settings: { ...current.settings, ...incoming, workspacePath: current.settings.workspacePath } }));
    });
    const offAuthUpdate = window.agentParty.onAuthUpdate?.((payload) => {
      setState((current) => ({ ...current, auth: payload as InitialAppState["auth"] }));
    });
    // The push sends the raw snapshot; the initial fetch wraps it in `{ usage }`.
    const offUsageUpdate = window.agentParty.onUsageUpdate?.((payload) => setUsageLimits((payload as UsageLimitsSnapshot) || {}));
    void window.agentParty.getUsageLimits?.().then((res) => { if (res?.usage) setUsageLimits(res.usage); });
    const offNavigate = window.agentParty.onNavigate((view) => {
      if (isViewId(view)) setCurrentView(view);
    });
    const offWorkspaceChoose = window.agentParty.onWorkspaceChoose(() => { void chooseWorkspace(); });
    const offNewSession = window.agentParty.onNewSession(() => { void createParty(); setCurrentView("workbench"); });
    const offRefreshHistory = window.agentParty.onRefreshHistory(() => { void refreshHistory(); setCurrentView("sessions"); });
    return () => {
      offEvents();
      offSnapshot();
      offSessions();
      offPartyUpdate();
      offModelsUpdate();
      offSettingsUpdate?.();
      offAuthUpdate?.();
      offUsageUpdate?.();
      offQaLayout();
      offQaOpenSub();
      offNavigate();
      offWorkspaceChoose();
      offNewSession();
      offRefreshHistory();
    };
  }, []);

  // Keep "seen" lengths current for every member visible in a panel, so unread
  // only accrues while a member is backgrounded.
  useEffect(() => {
    setSeenLengths((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const name of visibleMembers) {
        const sessionId = members.find((member) => member.name === name)?.sessionId;
        const length = sessionId ? logsBySession[sessionId]?.length || 0 : 0;
        if (next[name] !== length) {
          next[name] = length;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [visibleMembers, logsBySession, members]);

  // Restore each member's persisted transcript from disk once, so a reopened app
  // (or a closed member) shows its past conversation. Visible members are fetched
  // FIRST so the panels on screen fill in immediately on a party switch; the rest
  // still prefetch right after, keeping a switch to a backgrounded member instant.
  // `restoredByMember[key]` stays UNDEFINED until the fetch settles — it is the
  // "restore completed" signal the save effect below gates on. The old version
  // wrote a `[]` sentinel up front, so a session whose first events arrived
  // before the (slow, e.g. WSL-remote) fetch resolved was never seeded, and the
  // debounced save then overwrote the on-disk transcript with just the new
  // session's blocks — losing the member's whole history (SEL-6910 incident).
  const [restoreRetryNonce, setRestoreRetryNonce] = useState(0);
  const restoreRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ordered = [...members].sort(
      (a, b) => Number(!visibleMembers.includes(a.name)) - Number(!visibleMembers.includes(b.name)),
    );
    for (const member of ordered) {
      const key = memberKey(member);
      if (restoredRef.current[key] !== undefined || restoreRequestedRef.current.has(key)) {
        continue;
      }
      restoreRequestedRef.current.add(key);
      void window.agentParty.getMemberTranscript?.(member.name)?.then((raw) => {
        const blocks = Array.isArray(raw) ? (raw as TranscriptBlock[]) : [];
        // Always record the result (even empty): it marks the restore as done.
        setRestoredByMember((current) => ({ ...current, [key]: blocks }));
        if (!blocks.length) {
          return;
        }
        // Retro-seed: if this member's live session already produced transcript
        // blocks while the fetch was in flight (so the first-event seeding was
        // skipped), prepend the restored history now instead of dropping it.
        const live = membersRef.current.find((item) => memberKey(item) === key);
        const sid = live?.sessionId;
        if (sid) {
          setLogsBySession((current) => {
            const existing = current[sid];
            if (existing === undefined || existing.some((block) => block.id === blocks[0]?.id)) {
              return current;
            }
            return { ...current, [sid]: [...blocks, ...existing] };
          });
        }
      }).catch(() => {
        // Surface and retry — silently treating a failed read as "no history"
        // is what let the save path clobber the on-disk transcript.
        restoreRequestedRef.current.delete(key);
        setPartyNotice(`'${member.name}' 대화 기록 복원 실패 — 다시 시도합니다.`);
        setTimeout(() => setRestoreRetryNonce((n) => n + 1), 2000);
      });
    }
  }, [members, visibleMembers, restoreRetryNonce]);

  // Serializes saves per member. Two overlapping saves for one member could land
  // out of order and persist the OLDER transcript last, so each member's saves
  // run in a chain; the delta is computed when a link actually runs.
  const saveChainRef = useRef<Record<string, Promise<void>>>({});

  /**
   * Persists one member's transcript as an APPEND when possible.
   *
   * `restoredByMember[key]` mirrors what is on disk, and transcript blocks are
   * immutable (events rebuild the blocks they touch), so the unchanged prefix is
   * found by IDENTITY — everything after it is what needs saving. Sending only
   * that matters because the engine RPC is a single stdio pipe shared with
   * `sendUserTurn`: a full save of a 25 MB transcript queued ahead of a user turn
   * delayed it by 33 seconds, with no reasoning shown because the turn had not
   * reached the harness yet.
   */
  const persistTranscript = useCallback(async (name: string, key: string, blocks: TranscriptBlock[]) => {
    const persisted = restoredRef.current[key];
    if (persisted === blocks) {
      return;
    }
    const save = buildTranscriptSave(persisted, blocks);
    try {
      let result = await window.agentParty.saveMemberTranscript?.(name, save);
      if (result && !result.applied && save.afterId) {
        // The engine could not anchor the append against its stored transcript.
        // Resend in full rather than let the two sides silently diverge.
        result = await window.agentParty.saveMemberTranscript?.(name, { blocks });
      }
      if (result && !result.applied) {
        setPartyNotice(`'${name}' 대화 기록 저장 실패 (${result.reason || "unknown"})`);
        return;
      }
      setRestoredByMember((current) => (current[key] === blocks ? current : { ...current, [key]: blocks }));
    } catch (error) {
      setPartyNotice(`'${name}' 대화 기록 저장 실패 — ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // Persist each active member's transcript to disk (debounced), and keep the
  // restored copy in sync so closing the member (or the app) preserves it. The
  // main side also captures the harness thread id here, so a reopen resumes it.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const member of membersRef.current) {
        const blocks = member.sessionId ? logsBySession[member.sessionId] : undefined;
        const key = memberKey(member);
        // NEVER save before this member's restore has settled: the live blocks
        // are not yet seeded with the on-disk history, and a wholesale save here
        // would overwrite (lose) it. Once restored resolves, the retro-seed above
        // folds the history in and saving becomes safe.
        if (restoredRef.current[key] === undefined) {
          continue;
        }
        // Unchanged since the last persist. This effect fires on ANY session's
        // events, so without this test one member's streaming re-saved every
        // other member's transcript too.
        if (!blocks || !blocks.length || restoredRef.current[key] === blocks) {
          continue;
        }
        const chain = saveChainRef.current[key] || Promise.resolve();
        saveChainRef.current[key] = chain.then(() => persistTranscript(member.name, key, blocks));
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [logsBySession, persistTranscript]);

  // Auto-dismiss the status toast so a transient notice doesn't linger.
  useEffect(() => {
    if (!partyNotice) {
      return;
    }
    const timer = setTimeout(() => setPartyNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [partyNotice]);

  // OAuth is completed in the system browser. Poll the shared AppController
  // state only while an approval is pending; the button disappears as soon as
  // /v1/models proves the subscription was loaded.
  const subscriptionAuthPending = state.auth.some((provider) => provider.status === "pending");
  useEffect(() => {
    if (!subscriptionAuthPending) {
      return;
    }
    const timer = setInterval(() => {
      void window.agentParty.listAuth()
        .then((auth) => setState((current) => ({ ...current, auth })))
        .catch((error) => setPartyNotice(`구독 인증 상태 확인 실패: ${error instanceof Error ? error.message : String(error)}`));
    }, 1500);
    return () => clearInterval(timer);
  }, [subscriptionAuthPending]);

  async function chooseWorkspace() {
    const settings = await window.agentParty.chooseWorkspace();
    setState((current) => ({ ...current, settings }));
    const party = await window.agentParty.listParty();
    setState((current) => ({ ...current, party }));
  }

  async function createParty(name?: string) {
    const result = await window.agentParty.createParty({ name: (name ?? "").trim() || "새 파티" });
    await applyPartyResult(result);
    setCurrentView("workbench");
  }

  async function selectParty(partyId: string) {
    const result = await window.agentParty.selectParty(partyId);
    await applyPartyResult(result);
  }

  async function closeSession(sessionId: string) {
    await window.agentParty.closeSession(sessionId);
    setLogsBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setSubagentsBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setActiveSessionId((current) => (current === sessionId ? "" : current));
  }

  async function refreshHistory() {
    const result = await window.agentParty.listResumableSessions(state.settings.workspacePath);
    setState((current) => ({ ...current, resumableSessions: result.sessions || [], resumableSessionsError: result.error }));
  }

  async function resumeHistorySession(sessionId: string) {
    const session = await window.agentParty.resumeSession(sessionId, state.settings.workspacePath);
    if (!session) {
      return;
    }
    setState((current) => ({ ...current, sessions: upsertSession(current.sessions, session) }));
    setActiveSessionId(session.id);
  }

  async function saveOpenRouterKey() {
    if (!openRouterDraft.trim()) {
      return;
    }
    const auth = await window.agentParty.setOpenRouterKey(openRouterDraft.trim());
    setOpenRouterDraft("");
    setState((current) => ({ ...current, auth }));
  }

  async function refreshParty() {
    const party = await window.agentParty.listParty();
    setState((current) => ({ ...current, party }));
  }

  async function applyPartyResult(result: PartyCommandResult, notify = true) {
    // `notify` is off for routine sends: a toast on every message ("Message sent
    // to 'X'.") is noise. State still updates; real send failures surface below.
    if (notify) {
      setPartyNotice(result.message);
    }
    if (result.members) {
      setState((current) => ({
        ...current,
        party: {
          parties: result.parties || current.party.parties || [],
          currentPartyId: result.currentPartyId || current.party.currentPartyId,
          members: result.members || [],
          messages: result.messages || current.party.messages || [],
        },
      }));
      if (result.session) {
        setState((current) => ({ ...current, sessions: upsertSession(current.sessions, result.session!) }));
        setActiveSessionId(result.session.id);
      }
      return;
    }
    await refreshParty();
  }

  async function createMemberInline(input: {
    name: string;
    requirement: string;
    runtime: string;
    model?: string;
    effort?: string;
    reasoning?: string;
    reasoningBudget?: number;
    permissionMode?: import("../shared/types").PermissionModeSetting;
    codexPolicy?: import("../shared/codexPolicy").CodexPolicy;
  }) {
    const result = await window.agentParty.createPartyMember({ ...input, partyId: selectedParty?.id });
    await applyPartyResult(result);
  }

  // Direct removal for the Workbench sidebar, which owns its own confirm UI.
  async function removeMemberDirect(name: string) {
    const result = await window.agentParty.removePartyMember(name);
    await applyPartyResult(result);
  }

  // Deletes a whole party (cascades to its members); the sidebar arms a confirm
  // click before calling this.
  async function removePartyDirect(partyId: string) {
    const result = await window.agentParty.deleteParty(partyId);
    await applyPartyResult(result);
  }

  async function toggleDebug(enabled: boolean) {
    const settings = await window.agentParty.updateSettings({ debugEnabled: enabled });
    setState((current) => ({ ...current, settings }));
  }

  async function saveCompactDefault(setting: AutoCompactSetting) {
    const settings = await window.agentParty.updateSettings({ compactDefault: setting });
    setState((current) => ({ ...current, settings }));
  }

  // --- Workbench actions (addressed by member name) -----------------------
  function sessionIdFor(name: string): string | undefined {
    const sessionId = members.find((member) => member.name === name)?.sessionId;
    return sessionId && sessions.some((session) => session.id === sessionId) ? sessionId : undefined;
  }

  async function connectSubscription(provider: "codex" | "claude") {
    try {
      const result = await window.agentParty.loginSubscription(provider);
      setState((current) => ({ ...current, auth: result.auth }));
      setPartyNotice(result.detail);
    } catch (error) {
      setPartyNotice(`구독 연결을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      const auth = await window.agentParty.listAuth();
      setState((current) => ({ ...current, auth }));
    }
  }

  /** Restored transcript for one concrete member identity, never name-only. */
  function restoredTranscriptFor(member?: PartyMember): TranscriptBlock[] | undefined {
    return member ? restoredRef.current[memberKey(member)] : undefined;
  }

  /** Prepends restored history to a new session even if startup events arrived first. */
  function seedRestoredTranscript(sessionId: string, restored?: TranscriptBlock[]): void {
    if (!restored?.length) {
      return;
    }
    setLogsBySession((current) => {
      const existing = current[sessionId];
      if (!existing?.length) {
        return { ...current, [sessionId]: restored };
      }
      const restoredIds = new Set(restored.map((block) => block.id));
      if (existing.some((block) => restoredIds.has(block.id))) {
        return current;
      }
      return { ...current, [sessionId]: [...restored, ...existing] };
    });
  }

  /**
   * Runs a compaction for a member and shows the transient toolbar spinner
   * (~1.4s, matching the design's icon swap). The spinner is cosmetic — the
   * actual context drop arrives via the snapshot; the auto-compact re-fire guard
   * is the arm/disarm ref, not this flag. A no-op without a live session (nothing
   * to compact), surfaced as a notice rather than a silent nothing.
   */
  function runCompact(name: string): void {
    const sessionId = sessionIdFor(name);
    if (!sessionId) {
      setPartyNotice(`'${name}' 세션이 없어 압축할 컨텍스트가 없습니다.`);
      return;
    }
    void window.agentParty.compact(sessionId);
    setCompactingByMember((current) => ({ ...current, [name]: true }));
    window.setTimeout(() => {
      setCompactingByMember((current) => {
        if (!current[name]) return current;
        const next = { ...current };
        delete next[name];
        return next;
      });
    }, 1400);
  }

  // Starts a member's session if one isn't already active, returning its id.
  // Starts with the MEMBER's own configured runtime — not the global default.
  // Precedence: an explicit per-member runtime draft (RuntimeModal) > the
  // member's stored config (set at creation) > the global default. Falling back
  // straight to the global model here overwrote a member's model (e.g. a Kimi
  // member flipped to the global Sonnet on first chat). `startingRef` guards
  // against concurrent starts for the same member.
  async function ensureSession(name: string, opts: { auto?: boolean } = {}): Promise<string | undefined> {
    const existing = sessionIdFor(name);
    if (existing) {
      return existing;
    }
    const member = members.find((item) => item.name === name);
    const identity = member ? memberKey(member) : name;
    if (startingRef.current.has(identity)) {
      return undefined;
    }
    startingRef.current.add(identity);
    try {
      const draft = runtimeDrafts[name];
      const memberRoute = findRoute(member?.model, routes);
      // The member already carries its harness's model/effort/permission (set at
      // creation from that harness's defaults); fall back to the same harness's
      // defaults if somehow unset. Provider is inferred from the model route.
      const harnessDefaults = harnessDefaultsOf(state.settings, (member?.runtime === "codex" ? "codex" : "claude-code"));
      const result = await window.agentParty.startPartyMember(name, {
        // Opportunistic starts must not resurrect a member closed meanwhile.
        auto: opts.auto,
        selectedProviderId: draft?.providerId || (memberRoute?.providerId as any),
        model: draft?.model || member?.model || harnessDefaults.model,
        effort: (draft?.effort as any) || (member?.effort as any) || harnessDefaults.effort,
        permissionMode: (draft?.permissionMode as any) || (member?.permissionMode as any) || harnessDefaults.permissionMode,
      });
      await applyPartyResult(result);
      // The engine deliberately skipped an auto-start on a closed member — an
      // intentional no-op, not a failure worth a notice.
      if (opts.auto && result.member?.status === "closed") {
        return undefined;
      }
      // Seed the (resumed) session's transcript with the member's restored history
      // so the conversation continues visibly, matching the harness thread resume.
      const sid = result.session?.id;
      const restored = restoredTranscriptFor(result.member || member);
      if (sid) {
        seedRestoredTranscript(sid, restored);
      }
      return sid;
    } finally {
      startingRef.current.delete(identity);
    }
  }

  const actions: WorkbenchActions = {
    async sendMessage(name, text, attachments) {
      // Optimistic echo when the member already has a live session (instant feel);
      // for a not-yet-started member the echo is appended once the shared send
      // path returns its session id below.
      const known = sessionIdFor(name);
      if (known) {
        setLogsBySession((current) => appendBlock(current, known, { id: crypto.randomUUID(), kind: "user", text, attachments, at: nowTime() }));
      }
      // Same route as the HTTP API: the backend ensures the member's session
      // (starting it with the member's own config if needed) and delivers the
      // user turn. UI and agents go through the identical AppController method.
      const result = await window.agentParty.sendMemberMessage(name, text, attachments);
      await applyPartyResult(result, false);
      const sessionId = result.member?.sessionId || known;
      if (!sessionId) {
        setPartyNotice(`'${name}' 세션을 시작하지 못했습니다.`);
        return;
      }
      if (!known) {
        // Freshly started: seed the restored history, then echo the just-sent turn.
        const restored = restoredTranscriptFor(result.member || members.find((item) => item.name === name));
        seedRestoredTranscript(sessionId, restored);
        setLogsBySession((current) => appendBlock(current, sessionId, { id: crypto.randomUUID(), kind: "user", text, attachments, at: nowTime() }));
      }
    },
    prewarm(name) {
      // Init the visible member ahead of the first turn. Panel owns WHEN to try
      // (on activation/remount); ensureSession only deduplicates an in-flight
      // start. A lifetime "already prewarmed" set made a member impossible to
      // reopen after its session disappeared or after switching between parties
      // that both contain `main`: only sending a chat could revive it.
      const member = members.find((item) => item.name === name);
      if (sessionIdFor(name) || member?.status === "closed") {
        return;
      }
      void ensureSession(name, { auto: true }).then((id) => {
        if (!id) {
          setPartyNotice(`'${name}' 세션을 미리 준비하지 못했습니다. 메시지를 보내면 다시 시도합니다.`);
        }
      });
    },
    approve(name, requestId, behavior, updatedInput) {
      const sessionId = sessionIdFor(name);
      if (!sessionId) {
        return;
      }
      void window.agentParty.approve(sessionId, requestId, behavior, updatedInput);
      setLogsBySession((current) => markApprovalResolved(current, sessionId, requestId, behavior));
    },
    answerQuestion(name, requestId, input, answers) {
      const sessionId = sessionIdFor(name);
      if (!sessionId) {
        return;
      }
      const updatedInput = { ...(input && typeof input === "object" ? input : {}), answers };
      void window.agentParty.approve(sessionId, requestId, "allow", updatedInput);
      setLogsBySession((current) => markApprovalResolved(current, sessionId, requestId, "allow", answers));
    },
    interrupt(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.interrupt(sessionId);
    },
    forceStop(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.forceStop(sessionId);
    },
    restart(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.restart(sessionId);
    },
    respawn(name) {
      // Reload the member's session while continuing the conversation
      // (respawnMember: restart + resume the same harness thread). Rebuilds from
      // the member's current config and re-reads MCP, so newly-added servers
      // take effect without losing context.
      void window.agentParty.respawnPartyMember(name);
    },
    compact(name) {
      runCompact(name);
    },
    setAutoCompact(name, setting) {
      // Persist through the shared party-action path; the party:update broadcast
      // reflects it back into every member view (toolbar pill + sidebar badge).
      // Re-arm the trigger so a fresh threshold takes effect immediately.
      autoArmedRef.current[name] = true;
      void window.agentParty.setMemberAutoCompact(name, setting ?? null);
    },
    closeSession(name) {
      // Closing the tab tears down the member's session and marks it closed, so
      // it stops occupying context / provider usage. Addressed by member name
      // (not sessionId): a prewarmed-but-not-yet-bound member still gets closed,
      // and the closed status blocks auto-prewarm from resurrecting it.
      void window.agentParty.closePartyMember(name);
    },
    async applyRuntime(name, runtime) {
      if (runtime.debug !== state.settings.debugEnabled) {
        await toggleDebug(runtime.debug);
      }
      const sessionId = sessionIdFor(name);
      const member = members.find((item) => item.name === name);
      const selectedHarness = runtime.route?.harnessId === "codex" ? "codex" : "claude-code";
      const currentHarness = member?.runtime === "codex" ? "codex" : "claude-code";
      if (runtime.route && selectedHarness !== currentHarness) {
        // A harness is the adapter PROCESS, not model metadata. Recreate the
        // prewarmed session only when the actual selected harness changes.
        // Cross-routed models stay inside that harness process.
        const result = await window.agentParty.respawnPartyMember(name, {
          selectedHarnessId: selectedHarness,
          selectedProviderId: runtime.route.providerId,
          model: runtime.route.model,
          effort: runtime.effort,
          thinking: runtime.thinkingMode,
          thinkingBudget: runtime.thinkingBudget,
        });
        await applyPartyResult(result);
      } else {
        if (runtime.route && sessionId) {
          await window.agentParty.setModel(sessionId, runtime.route.model, runtime.route.providerId, runtime.route.runtimeModel);
        }
        if (sessionId && runtime.effort) {
          await window.agentParty.setEffort(sessionId, runtime.effort);
        }
        if (sessionId && runtime.thinkingMode) {
          await window.agentParty.setThinking(sessionId, runtime.thinkingMode, runtime.thinkingBudget);
        }
      }
      setRuntimeDrafts((current) => ({
        ...current,
        [name]: {
          ...current[name],
          model: runtime.route?.model ?? current[name]?.model,
          providerId: runtime.route?.providerId ?? current[name]?.providerId,
          runtimeModel: runtime.route?.runtimeModel ?? current[name]?.runtimeModel,
          effort: runtime.effort ?? current[name]?.effort,
          thinking: runtime.thinkingMode ? runtime.thinkingMode !== "disabled" : current[name]?.thinking,
        },
      }));
    },
    setEffort(name, effort) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setEffort(sessionId, effort);
      }
      setRuntimeDrafts((current) => ({ ...current, [name]: { ...current[name], effort } }));
    },
    setThinking(name, mode, budget) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setThinking(sessionId, mode, budget);
      }
    },
    setCodexPolicy(name, policy) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setCodexPolicy(sessionId, policy);
      }
    },
    async listMcp(name) {
      const sessionId = sessionIdFor(name);
      const member = members.find((item) => item.name === name);
      const harness = member?.runtime === "codex" ? "codex" : "claude-code";
      if (!sessionId) {
        return { supported: true, harness, servers: [], note: "세션을 먼저 시작하세요 (멤버에게 메시지를 보내거나 패널을 열면 준비됩니다)." };
      }
      return window.agentParty.listMcpServers(sessionId) as Promise<McpServerSnapshot>;
    },
    async reconnectMcp(name, server) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        await window.agentParty.reconnectMcpServer(sessionId, server);
      }
    },
    async toggleMcp(name, server, enabled) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        await window.agentParty.setMcpServerEnabled(sessionId, server, enabled);
      }
    },
    async authenticateMcp(name, server) {
      const sessionId = sessionIdFor(name);
      if (!sessionId) {
        return { note: "세션을 먼저 시작하세요." };
      }
      return window.agentParty.authenticateMcpServer(sessionId, server) as Promise<McpAuthResult>;
    },
    setPermissionMode(name, mode) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setPermissionMode(sessionId, mode);
      }
      setRuntimeDrafts((current) => ({ ...current, [name]: { ...current[name], permissionMode: mode } }));
    },
  };

  /** Persists one harness's creation defaults (model/effort/reasoning/permission). */
  async function saveHarnessDefaults(harnessId: "claude-code" | "codex", patch: Partial<HarnessDefaults>) {
    const current = state.settings.harnessDefaults[harnessId];
    const settings = await window.agentParty.updateSettings({
      harnessDefaults: { ...state.settings.harnessDefaults, [harnessId]: { ...current, ...patch } },
    });
    setState((prev) => ({ ...prev, settings }));
  }

  /** Sets which harness a brand-new member defaults to. */
  async function setDefaultHarness(harnessId: "claude-code" | "codex") {
    const settings = await window.agentParty.updateSettings({ selectedHarnessId: harnessId });
    setState((prev) => ({ ...prev, settings }));
  }

  const navItems: Array<{ id: ViewId; label: string; icon: JSX.Element }> = [
    { id: "workbench", label: "Workbench", icon: <Sparkles size={18} /> },
    { id: "sessions", label: "세션", icon: <History size={18} /> },
    { id: "auth", label: "인증", icon: <KeyRound size={18} /> },
    { id: "runtime", label: "런타임", icon: <SlidersHorizontal size={18} /> },
    { id: "automation", label: "자동화", icon: <Settings size={18} /> },
  ];

  const isDark = theme.themeId === "dark";

  // Party members driving each harness subscription/account indicator. Models
  // routed through OpenRouter do not replace the selected harness process.
  const membersByProvider = useMemo<Partial<Record<UsageProviderId, number>>>(() => {
    const counts: Partial<Record<UsageProviderId, number>> = {};
    for (const member of members) {
      const harness = member.runtime === "codex" ? "codex" : "claude-code";
      const provider: UsageProviderId = harness === "codex" ? "codex" : "claude";
      if (provider) {
        counts[provider] = (counts[provider] || 0) + 1;
      }
    }
    return counts;
  }, [members]);

  async function refreshUsageLimits() {
    setUsageRefreshing(true);
    try {
      const res = await window.agentParty.refreshUsageLimits?.();
      if (res?.usage) {
        setUsageLimits(res.usage);
      }
    } finally {
      setUsageRefreshing(false);
    }
  }

  // Global usage indicator — lives under the "작업공간" button in each screen
  // header (reused across views), not the titlebar.
  const usagePill = (
    <UsageLimitPill
      usage={usageLimits}
      membersByProvider={membersByProvider}
      onOpenSettings={() => setCurrentView("automation")}
      onRefresh={() => { void refreshUsageLimits(); }}
      refreshing={usageRefreshing}
    />
  );

  return (
    <div className="app-shell">
      <div className="app-titlebar">
        <div className="titlebar-drag">
          <div className="titlebar-brand"><span className="brand-mark"><span className="brand-mark-dot" /></span><span className="brand-name">AgentParty</span><small className="brand-sub">{viewTitle(currentView)}</small></div>
          <button type="button" className="titlebar-action no-drag" title="테마 전환" onClick={theme.cycleTheme}>
            {isDark ? <Moon size={14} /> : <Sun size={14} />}
          </button>
        </div>
        <div className="window-controls">
          <button type="button" className="window-button" title="최소화" onClick={() => window.agentParty.minimizeWindow()}><Minus size={15} /></button>
          <button type="button" className="window-button" title="최대화" onClick={() => window.agentParty.maximizeWindow()}><Maximize2 size={14} /></button>
          <button type="button" className="window-button close" title="닫기" onClick={() => window.agentParty.closeWindow()}><X size={16} /></button>
        </div>
      </div>

      <div className="app-body">
        <nav className="nav-rail" aria-label="기본 탐색">
          <div className="nav-items">
            {navItems.map((item) => (
              <button key={item.id} className={"nav-item " + (currentView === item.id ? "active" : "")} onClick={() => setCurrentView(item.id)} title={item.label}>
                {item.icon}
              </button>
            ))}
          </div>
          <div className="nav-spacer" />
          <div className="nav-avatar" title="계정">JD</div>
        </nav>

        <main className="program-main">
          {currentView === "workbench" ? (
            <>
              <header className="screen-header">
                <div className="screen-title">
                  <h1>Workbench</h1>
                  <span className="wb-mono screen-repo">
                    {state.workspace?.kind === "wsl" && (
                      <span className="host-badge" title={`WSL distro: ${state.workspace.distro}`}>WSL · {state.workspace.distro}</span>
                    )}
                    {state.workspace?.path || displayPath(state.settings.workspacePath) || "작업공간 없음"}
                  </span>
                  <p>멤버를 탭으로 열고 패널을 나누어 여러 세션을 한 화면에서 관리합니다.</p>
                </div>
                <div className="screen-actions">
                  <button className="ghost-btn" onClick={chooseWorkspace}><FolderOpen size={15} /> 작업공간</button>
                  {usagePill}
                </div>
              </header>
              <Workbench
                parties={state.party.parties || []}
                activePartyId={state.party.currentPartyId}
                views={views}
                routes={routes}
                codexModels={state.codexModels}
                onRefreshCodexModels={() => void window.agentParty.refreshCodexModels()}
                defaultProfile={defaultMemberProfileOf(state.settings)}
                harnessDefaults={state.settings.harnessDefaults}
                debugEnabled={state.settings.debugEnabled}
                sidebarOpen={sidebarOpen}
                layoutRequest={layoutRequest}
                subagentOpenRequest={subagentOpenRequest}
                actions={actions}
                onCreateParty={(name) => void createParty(name)}
                onCreateMember={(input) => void createMemberInline(input)}
                onRemoveMember={(name) => void removeMemberDirect(name)}
                onRemoveParty={(partyId) => void removePartyDirect(partyId)}
                onSelectParty={(partyId) => void selectParty(partyId)}
                onMemberOpened={() => undefined}
                onVisibleMembersChange={setVisibleMembers}
                onToggleSidebar={(open) => {
                  setSidebarOpen(open);
                  try { window.localStorage.setItem("agentparty.sidebarOpen", open ? "1" : "0"); } catch { /* best-effort */ }
                }}
              />
            </>
          ) : (
            <>
              <header className="screen-header">
                <div className="screen-title">
                  <h1>{viewTitle(currentView)}</h1>
                  <p>{viewSubtitle(currentView)}</p>
                  <div className="screen-chips">
                    <span className="screen-chip">
                      <FolderOpen size={13} />
                      <span className="wb-mono">
                        {state.workspace?.kind === "wsl" && <span className="host-badge" title={`WSL distro: ${state.workspace.distro}`}>WSL · {state.workspace.distro}</span>}
                        {state.workspace?.path || displayPath(state.settings.workspacePath) || "작업공간 없음"}
                      </span>
                    </span>
                  </div>
                </div>
                <div className="screen-actions">
                  <button className="ghost-btn" onClick={chooseWorkspace}><FolderOpen size={15} /> 작업공간</button>
                  {usagePill}
                </div>
              </header>
              <div className="program-scroll">
              {currentView === "sessions" && (
                <SessionsView
                  sessions={sessions}
                  resumable={state.resumableSessions || []}
                  resumableError={state.resumableSessionsError}
                  onOpen={(id) => { setActiveSessionId(id); setCurrentView("workbench"); }}
                  onClose={closeSession}
                  onRefresh={refreshHistory}
                  onResume={resumeHistorySession}
                />
              )}
              {currentView === "auth" && (
                <AuthView
                  auth={state.auth}
                  draft={openRouterDraft}
                  onDraft={setOpenRouterDraft}
                  onSave={saveOpenRouterKey}
                  onTest={async () => { const auth = await window.agentParty.testOpenRouterKey(); setState((current) => ({ ...current, auth })); }}
                  onConnectSubscription={connectSubscription}
                />
              )}
              {currentView === "runtime" && (
                <RuntimeSettingsView
                  routes={routes}
                  harnesses={state.harnesses as any[]}
                  router={state.router.baseUrl}
                  settings={state.settings}
                  codexModels={state.codexModels}
                  onRefreshCodexModels={() => void window.agentParty.refreshCodexModels()}
                  onSaveHarnessDefaults={saveHarnessDefaults}
                  onSetDefaultHarness={setDefaultHarness}
                  onToggleDebug={toggleDebug}
                  onSaveCompactDefault={saveCompactDefault}
                />
              )}
              {currentView === "automation" && (
                <AutomationView automationApi={state.automationApi} logs={state.logs} debugEnabled={state.settings.debugEnabled} onToggleDebug={toggleDebug} />
              )}
              </div>
            </>
          )}
        </main>
      </div>

      {partyNotice && (
        <div className="app-toast" role="status">
          <span>{partyNotice}</span>
          <button type="button" className="app-toast-x" title="닫기" onClick={() => setPartyNotice("")}><X size={13} /></button>
        </div>
      )}
    </div>
  );
}

