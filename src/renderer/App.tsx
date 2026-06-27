import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, History, KeyRound, Maximize2, Minus, Moon, Settings, SlidersHorizontal, Sparkles, Sun, UsersRound, X } from "lucide-react";
import type { InitialAppState, PartyCommandResult, SessionView } from "../shared/types";
import { useTheme } from "./theme/ThemeProvider";
import { Workbench } from "./workbench/Workbench";
import type { WorkbenchActions } from "./workbench/actions";
import type { MemberView, TranscriptBlock } from "./workbench/types";
import { buildMemberView } from "./workbench/memberStatus";
import { RouteLike, routeKey } from "./workbench/routes";
import { displayPath, initialState, isViewId, MemberRuntimeDraft, routeKeyForModel, ViewId, viewSubtitle, viewTitle } from "./app/appState";
import { AuthView, AutomationView, PartyAdminView, RuntimeSettingsView, SessionsView } from "./app/secondaryViews";
import { appendBlock, applyEvents, markApprovalResolved, nowTime, upsertSession } from "./app/transcriptEvents";

export function App() {
  const theme = useTheme();
  const [state, setState] = useState<InitialAppState>(initialState);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [logsBySession, setLogsBySession] = useState<Record<string, TranscriptBlock[]>>({});
  const [openRouterDraft, setOpenRouterDraft] = useState("");
  const [partyNameDraft, setPartyNameDraft] = useState("");
  const [partyDraft, setPartyDraft] = useState({ name: "", requirement: "", initialTask: "", runtime: "claude-code" });
  const [memberMessages, setMemberMessages] = useState<Record<string, string>>({});
  const [partyNotice, setPartyNotice] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState("");
  const [currentView, setCurrentView] = useState<ViewId>("workbench");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [visibleMembers, setVisibleMembers] = useState<string[]>([]);
  const [seenLengths, setSeenLengths] = useState<Record<string, number>>({});
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<string, MemberRuntimeDraft>>({});
  const [globalRuntime, setGlobalRuntime] = useState({ routeKey: "", effort: "medium", permissionMode: "default" });
  const [layoutRequest, setLayoutRequest] = useState<{ panels: string[][]; nonce: number } | null>(null);
  // Tracks whether a live party broadcast has arrived, so a late-resolving
  // initial-state load cannot clobber it with a stale snapshot.
  const partyBroadcastSeen = useRef(false);

  const members = state.party.members;
  const sessions = state.sessions;
  const routes = state.modelRoutes as RouteLike[];

  const selectedParty = useMemo(
    () => (state.party.parties || []).find((party) => party.id === state.party.currentPartyId) || (state.party.parties || [])[0],
    [state.party.currentPartyId, state.party.parties],
  );

  const views = useMemo<MemberView[]>(
    () => members.map((member) => buildMemberView({
      member,
      sessions,
      transcriptBySession: logsBySession,
      seenCount: seenLengths[member.name] ?? 0,
    })),
    [members, sessions, logsBySession, seenLengths],
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );

  useEffect(() => {
    void window.agentParty.getInitialState().then((next) => {
      // If a party broadcast already arrived, keep it (avoid the load race).
      setState((current) => (partyBroadcastSeen.current ? { ...next, party: current.party } : next));
      if (next.sessions?.[0]) {
        setActiveSessionId(next.sessions[0].id);
      }
      setGlobalRuntime({
        routeKey: routeKeyForModel(next.settings.claudeModel, next.modelRoutes as RouteLike[]),
        effort: next.settings.claudeEffort,
        permissionMode: next.settings.claudePermissionMode,
      });
    });

    const offEvents = window.agentParty.onSessionEvents((payload: any) => {
      setLogsBySession((current) => applyEvents(current, payload.sessionId, payload.events || []));
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
    const offQaLayout = window.agentParty.onQaLayout((payload) => {
      const panels = (payload as { panels?: string[][] })?.panels;
      if (Array.isArray(panels)) {
        setLayoutRequest({ panels, nonce: Date.now() });
        setCurrentView("workbench");
      }
    });
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
      offQaLayout();
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

  async function chooseWorkspace() {
    const settings = await window.agentParty.chooseWorkspace();
    setState((current) => ({ ...current, settings }));
    const party = await window.agentParty.listParty();
    setState((current) => ({ ...current, party }));
  }

  async function createParty(name?: string) {
    const result = await window.agentParty.createParty({ name: (name ?? partyNameDraft).trim() || "새 파티" });
    setPartyNameDraft("");
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

  async function applyPartyResult(result: PartyCommandResult) {
    setPartyNotice(result.message);
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

  async function createMember(event: FormEvent) {
    event.preventDefault();
    if (!partyDraft.name.trim() || !partyDraft.requirement.trim()) {
      setPartyNotice("멤버 이름과 책임을 입력해야 합니다.");
      return;
    }
    const result = await window.agentParty.createPartyMember({ ...partyDraft, partyId: selectedParty?.id });
    await applyPartyResult(result);
    if (result.ok) {
      setPartyDraft({ name: "", requirement: "", initialTask: "", runtime: "claude-code" });
    }
  }

  async function createMemberInline(input: { name: string; requirement: string; runtime: string }) {
    const result = await window.agentParty.createPartyMember({ ...input, partyId: selectedParty?.id });
    await applyPartyResult(result);
  }

  async function sendToMember(name: string) {
    const content = (memberMessages[name] || "").trim();
    if (!content) {
      return;
    }
    const result = await window.agentParty.sendPartyMessage(name, content, "user");
    setMemberMessages((current) => ({ ...current, [name]: "" }));
    await applyPartyResult(result);
  }

  async function memberAction(action: "close" | "bind" | "remove", name: string) {
    if (action === "remove" && removeConfirm !== name) {
      setRemoveConfirm(name);
      setPartyNotice(`'${name}' 멤버를 영구 삭제하려면 삭제를 한 번 더 누르세요.`);
      return;
    }
    const result = action === "close"
      ? await window.agentParty.closePartyMember(name)
      : action === "bind"
        ? await window.agentParty.bindPartyMember(name, activeSession?.id || "")
        : await window.agentParty.removePartyMember(name);
    setRemoveConfirm("");
    await applyPartyResult(result);
  }

  async function toggleDebug(enabled: boolean) {
    const settings = await window.agentParty.updateSettings({ debugEnabled: enabled });
    setState((current) => ({ ...current, settings }));
  }

  // --- Workbench actions (addressed by member name) -----------------------
  function sessionIdFor(name: string): string | undefined {
    const sessionId = members.find((member) => member.name === name)?.sessionId;
    return sessionId && sessions.some((session) => session.id === sessionId) ? sessionId : undefined;
  }

  const actions: WorkbenchActions = {
    async sendMessage(name, text) {
      let sessionId = sessionIdFor(name);
      if (!sessionId) {
        const draft = runtimeDrafts[name];
        const result = await window.agentParty.startPartyMember(name, {
          selectedProviderId: draft?.providerId || state.settings.selectedProviderId,
          model: draft?.model || state.settings.claudeModel,
          effort: (draft?.effort as any) || state.settings.claudeEffort,
          permissionMode: (draft?.permissionMode as any) || state.settings.claudePermissionMode,
        });
        await applyPartyResult(result);
        sessionId = result.session?.id;
      }
      if (!sessionId) {
        setPartyNotice(`'${name}' 세션을 시작하지 못했습니다.`);
        return;
      }
      setLogsBySession((current) => appendBlock(current, sessionId!, { id: crypto.randomUUID(), kind: "user", text, at: nowTime() }));
      await window.agentParty.sendMessage(sessionId, text);
    },
    approve(name, requestId, behavior) {
      const sessionId = sessionIdFor(name);
      if (!sessionId) {
        return;
      }
      void window.agentParty.approve(sessionId, requestId, behavior);
      setLogsBySession((current) => markApprovalResolved(current, sessionId, requestId, behavior));
    },
    interrupt(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.interrupt(sessionId);
    },
    restart(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.restart(sessionId);
    },
    compact(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.compact(sessionId);
    },
    async applyRuntime(name, runtime) {
      if (runtime.debug !== state.settings.debugEnabled) {
        await toggleDebug(runtime.debug);
      }
      const sessionId = sessionIdFor(name);
      if (runtime.route && sessionId) {
        await window.agentParty.setModel(sessionId, runtime.route.model, runtime.route.providerId, runtime.route.runtimeModel);
      }
      if (sessionId) {
        await window.agentParty.setEffort(sessionId, runtime.effort);
      }
      setRuntimeDrafts((current) => ({
        ...current,
        [name]: {
          ...current[name],
          model: runtime.route?.model ?? current[name]?.model,
          providerId: runtime.route?.providerId ?? current[name]?.providerId,
          runtimeModel: runtime.route?.runtimeModel ?? current[name]?.runtimeModel,
          effort: runtime.effort,
          thinking: runtime.thinking,
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
    setPermissionMode(name, mode) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setPermissionMode(sessionId, mode);
      }
      setRuntimeDrafts((current) => ({ ...current, [name]: { ...current[name], permissionMode: mode } }));
    },
  };

  async function applyGlobalRuntime() {
    const route = routes.find((item) => routeKey(item) === globalRuntime.routeKey);
    if (!route) {
      return;
    }
    const settings = await window.agentParty.updateSettings({
      selectedHarnessId: (route.harnessId as any) || "claude-code",
      selectedProviderId: (route.providerId as any) || "anthropic",
      claudeModel: route.model,
      claudeEffort: globalRuntime.effort as any,
      claudePermissionMode: globalRuntime.permissionMode as any,
    });
    setState((current) => ({ ...current, settings }));
  }

  const navItems: Array<{ id: ViewId; label: string; icon: JSX.Element }> = [
    { id: "workbench", label: "Workbench", icon: <Sparkles size={18} /> },
    { id: "sessions", label: "세션", icon: <History size={18} /> },
    { id: "party", label: "파티", icon: <UsersRound size={18} /> },
    { id: "auth", label: "인증", icon: <KeyRound size={18} /> },
    { id: "runtime", label: "런타임", icon: <SlidersHorizontal size={18} /> },
    { id: "automation", label: "자동화", icon: <Settings size={18} /> },
  ];

  const isDark = theme.themeId === "dark";

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
                  <span className="wb-mono screen-repo">{displayPath(state.settings.workspacePath) || "작업공간 없음"}</span>
                  <p>멤버를 탭으로 열고 패널을 나누어 여러 세션을 한 화면에서 관리합니다.</p>
                </div>
                <div className="screen-actions">
                  <button className="ghost-btn" onClick={chooseWorkspace}><FolderOpen size={15} /> 작업공간</button>
                  <button className="accent-btn" onClick={() => createParty()}><UsersRound size={15} /> 새 파티</button>
                </div>
              </header>
              <Workbench
                parties={state.party.parties || []}
                activePartyId={state.party.currentPartyId}
                views={views}
                routes={routes}
                debugEnabled={state.settings.debugEnabled}
                sidebarOpen={sidebarOpen}
                layoutRequest={layoutRequest}
                actions={actions}
                onCreateParty={(name) => void createParty(name)}
                onCreateMember={(input) => void createMemberInline(input)}
                onSelectParty={(partyId) => void selectParty(partyId)}
                onMemberOpened={() => undefined}
                onVisibleMembersChange={setVisibleMembers}
                onToggleSidebar={setSidebarOpen}
              />
            </>
          ) : (
            <>
              <header className="screen-header">
                <div className="screen-title">
                  <h1>{viewTitle(currentView)}</h1>
                  <p>{viewSubtitle(currentView, state.settings.workspacePath)}</p>
                </div>
                <div className="screen-actions">
                  <button className="ghost-btn" onClick={chooseWorkspace}><FolderOpen size={15} /> 작업공간</button>
                </div>
              </header>
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
              {currentView === "party" && (
                <PartyAdminView
                  parties={state.party.parties || []}
                  selectedParty={selectedParty}
                  members={members}
                  messages={state.party.messages || []}
                  partyError={state.party.error}
                  partyNameDraft={partyNameDraft}
                  partyDraft={partyDraft}
                  memberMessages={memberMessages}
                  removeConfirm={removeConfirm}
                  partyNotice={partyNotice}
                  hasActiveSession={Boolean(activeSession)}
                  onPartyNameDraft={setPartyNameDraft}
                  onCreateParty={() => void createParty()}
                  onSelectParty={(id) => void selectParty(id)}
                  onPartyDraft={setPartyDraft}
                  onCreateMember={createMember}
                  onMemberMessage={(name, value) => setMemberMessages((current) => ({ ...current, [name]: value }))}
                  onSendToMember={sendToMember}
                  onMemberAction={memberAction}
                  onRefresh={refreshParty}
                />
              )}
              {currentView === "auth" && (
                <AuthView
                  auth={state.auth}
                  draft={openRouterDraft}
                  onDraft={setOpenRouterDraft}
                  onSave={saveOpenRouterKey}
                  onTest={async () => { const auth = await window.agentParty.testOpenRouterKey(); setState((current) => ({ ...current, auth })); }}
                />
              )}
              {currentView === "runtime" && (
                <RuntimeSettingsView
                  routes={routes}
                  harnesses={state.harnesses as any[]}
                  draft={globalRuntime}
                  router={state.router.baseUrl}
                  settings={state.settings}
                  onDraft={setGlobalRuntime}
                  onApply={applyGlobalRuntime}
                  onToggleDebug={toggleDebug}
                />
              )}
              {currentView === "automation" && (
                <AutomationView automationApi={state.automationApi} logs={state.logs} debugEnabled={state.settings.debugEnabled} onToggleDebug={toggleDebug} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

