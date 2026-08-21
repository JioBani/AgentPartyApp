import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, BookOpen, FolderOpen, KeyRound, Maximize2, Minus, Moon, Settings, SlidersHorizontal, Sparkles, Sun, X } from "lucide-react";
import type { HarnessDefaults, HarnessId, InitialAppState, MemberPermissionInput, NativeCliAuthHost, NativeCliAuthProgress, NativeCliAuthProvider, NativeCliAuthTestResult, PartyCommandResult, PartyMember, PermissionModeSetting, SessionView } from "../shared/types";
import { HARNESS_IDS } from "../shared/types";
import { defaultMemberProfileOf, harnessDefaultsOf, harnessForRuntime } from "../shared/types";
import { applyNativeCliAuthProgress, nativeCliAuthProgressCheck } from "../shared/nativeCliAuth";
import { shouldAutoCompact, type AutoCompactSetting } from "../shared/autoCompact";
import type { IdleSleepSettings } from "../shared/idleSleep";
import type { WorkbenchLayout } from "../shared/workbenchLayout";
import type { GateReviewer, PartyGate } from "../shared/messageGate";
import type { PartyPrimerSectionPatch } from "./workbench/PartyPrimerSettings";
import type { PartyPrimerSectionId } from "../shared/partyPrimer";
import type { ComposerSettings } from "../shared/composerSettings";
import { fontStackFor, normalizeFontSettings, type FontSettings } from "../shared/appFonts";
import { publishFontProbe } from "./app/fontProbe";
import { reportNotice, useNoticeSink } from "./app/appNotice";
import type { CreateMemberInput, CreatePartyInput } from "./workbench/PartySidebar";
import { DEFAULT_PARTY_GROUP_ID, type PartyGroup, type RegisteredParty } from "../shared/partyGroups";
import { EMPTY_CWD_PREFERENCES, memberLocationsEqual, parseMemberLocation, serializeMemberLocation, type CwdPreferences, type ExecutionEnv, type MemberExecutionLocation, type MemberLocationRow } from "../shared/memberLocation";
import { useUpdateDialogSink } from "./app/updateDialog";
import type { MemberMessagingSettings } from "../shared/memberMessaging";
import { usePublishComposerPrefs } from "./app/composerPrefs";
import { usePublishFavoriteModels } from "./app/favoriteModelPrefs";
import { toggleFavoriteModel as nextFavoriteModels } from "../shared/favoriteModels";
import type { McpAuthResult, McpServerSnapshot } from "../shared/mcp";
import { providerOfRuntime, type UsageLimitsSnapshot, type UsageProviderId } from "../shared/usageLimits";
import { UsageLimitPill } from "./workbench/UsageLimitPill";
import type { UpdateStatus } from "../shared/appUpdate";
import { UpdatePill } from "./workbench/UpdatePill";
import { MobileDrivingPill } from "./workbench/MobileDrivingPill";
import { UpdateModal } from "./workbench/UpdateModal";
import { useTheme } from "./theme/ThemeProvider";
import { Workbench } from "./workbench/Workbench";
import type { WorkbenchActions } from "./workbench/actions";
import { createLatestMethodProxy } from "./workbench/stableActions";
import { PROGRESSIVE_TRANSCRIPT_GAP_MS } from "./workbench/transcriptScheduling";
import type { MemberView, Subagent, TranscriptBlock } from "./workbench/types";
import { buildMemberView } from "./workbench/memberStatus";
import { findRoute, RouteLike, routeKey } from "./workbench/routes";
import { ipcErrorMessage } from "./app/ipcError";
import { displayPath, initialState, isViewId, MemberRuntimeDraft, ViewId, viewSubtitle, viewTitle } from "./app/appState";
import { isAgentTabId, isSettingsTabId, type AgentTabId, type SettingsTabId } from "../shared/runtimeTabs";
import type { ApprovalDelivery } from "../shared/approvals";
import { AgentSettingsView, AuthView, SettingsView } from "./app/secondaryViews";
import { TokenUsageView } from "./usage/TokenUsageView";
import type { DiscordBridgeStatus } from "../shared/discordBridge";
import { appendBlock, applyEvents, buildTranscriptSave, markApprovalResolved, mergeRestoredTranscript, normalizeTranscriptBlocks, nowTime, removeBlock, upsertSession } from "../shared/transcriptEvents";
import { applySubagentEvents } from "./app/subagentEvents";
import { hasConnectedAccount } from "../shared/guideAuth";
import { nextGuideOfferAction } from "../shared/guideOffer";
import { GuideOfferDialog } from "./app/GuideOfferDialog";
import { GuideView } from "./guide/GuideView";
import { createI18n, I18nProvider } from "./i18n/I18nProvider";
import type { AppLocale } from "../shared/appLocale";
import { localized } from "./i18n/I18nProvider";
import { mergeRendererSessions, updateRendererSessionSnapshot } from "./app/sessionRenderState";
import { nextTranscriptRestore, nextTranscriptReveal } from "./app/transcriptRestorePlan";
import { DEFAULT_SIDEBAR_DRAWERS, type SidebarDrawerId, type SidebarDrawerState } from "../shared/sidebarDrawers";

/**
 * Stable per-member identity for renderer-side caches (restored transcripts).
 * A member NAME alone is NOT unique — every party has a `main`, and a
 * delete+recreate reuses the same name. Keying by `(partyId, name, createdAt)`
 * isolates same-named members across parties (feedback #5: party-switch bleed)
 * and treats a recreated member as fresh (feedback #7: recreate keeps old
 * messages), while the global on-disk store — partitioned by (party, member) —
 * stays the source of truth.
 */
function memberKey(member: { partyId?: string; name: string; createdAt?: string }): string {
  return `${member.partyId || "default"}::${member.name}::${member.createdAt || ""}`;
}

/**
 * Outcome of a session-start attempt. `skipped` is a deliberate no-op — the
 * member is closed, or a start for it is already in flight — and must not be
 * treated as (or retried like) a failure.
 */
interface EnsureSessionResult {
  sessionId?: string;
  error?: string;
  skipped?: boolean;
}

export function App() {
  const theme = useTheme();
  const [state, setState] = useState<InitialAppState>(initialState);
  const { t } = useMemo(() => createI18n(state.settings.locale), [state.settings.locale]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [logsBySession, setLogsBySession] = useState<Record<string, TranscriptBlock[]>>({});
  // Subagents folded from `subagent` events, kept separate from the transcript so
  // their output never mixes into the main chat (rendered in the panel's dock).
  const [subagentsBySession, setSubagentsBySession] = useState<Record<string, Subagent[]>>({});
  // Persisted transcripts restored from disk, keyed by member name — shown for a
  // closed member or right after an app reopen (before/without a live session).
  const [restoredByMember, setRestoredByMember] = useState<Record<string, TranscriptBlock[]>>({});
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  // Account/provider-scoped rate-limit usage (titlebar indicator). Global, pushed
  // by main; fetched once on mount and kept live via the "usage:update" channel.
  const [usageLimits, setUsageLimits] = useState<UsageLimitsSnapshot>({});
  // App self-update. Global like usage — one installed build per machine — so it
  // is fetched once and kept live via the "update:status" channel.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | undefined>();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [guideOfferOpen, setGuideOfferOpen] = useState(false);
  const guideOfferHandled = useRef(false);
  const [discord, setDiscord] = useState<DiscordBridgeStatus | undefined>();
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  // Transient status/error line (session start failures, etc.), surfaced as a toast.
  const [partyNotice, setPartyNotice] = useState("");
  const [currentView, setCurrentView] = useState<ViewId>("workbench");
  /** Tab requests sent by the shared AppController navigation path. */
  const [agentTabRequest, setAgentTabRequest] = useState<{ tab: AgentTabId; harness?: HarnessId; seq: number }>({ tab: "general", seq: 0 });
  const [settingsTabRequest, setSettingsTabRequest] = useState<{ tab: SettingsTabId; seq: number }>({ tab: "general", seq: 0 });
  // Sidebar open/closed persists across launches (README Electron note #6);
  // width is persisted separately in Workbench.
  /**
   * Which sidebar drawers are open. Two independent flags, because the point of
   * splitting them is that you can put the party list away while working with a
   * party's members — and get it back in one click.
   */
  const drawers = state.settings.sidebarDrawers || DEFAULT_SIDEBAR_DRAWERS;
  // The members whose tabs are FRONTMOST in a panel (drives unread counting).
  const [visibleMemberScope, setVisibleMemberScope] = useState<{ partyId: string; names: string[] }>({ partyId: "", names: [] });
  // Transcript data and transcript DOM have separate lifecycles. The former is
  // retained for fast tab reuse; the latter is revealed one visible panel per
  // yield so a warm party switch cannot remount every cached card at once.
  const [revealedMemberScope, setRevealedMemberScope] = useState<{ partyId: string; names: string[] }>({ partyId: "", names: [] });
  const [seenLengths, setSeenLengths] = useState<Record<string, number>>({});
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<string, MemberRuntimeDraft>>({});
  // Members with a compaction in flight (transient toolbar spinner).
  const [compactingByMember, setCompactingByMember] = useState<Record<string, boolean>>({});
  const [layoutRequest, setLayoutRequest] = useState<{ panels: string[][]; nonce: number } | null>(null);
  /**
   * The active party's tab layout as the MAIN process holds it. Fetched on a
   * party switch and replaced whenever another window on that party changes it,
   * so every window of one process shows the same tabs. `layout: undefined`
   * means nothing is stored for that party yet.
   */
  const [partyLayout, setPartyLayout] = useState<{ partyId: string; layout?: WorkbenchLayout } | undefined>();
  // QA-driven "open this subagent's detail" request (mock-driven detail QA).
  const [subagentOpenRequest, setSubagentOpenRequest] = useState<{ member: string; subId: string; nonce: number } | null>(null);
  const [gateOpenRequest, setGateOpenRequest] = useState<{ kind: "member" | "party"; member: string; nonce: number } | null>(null);
  // Tracks whether a live party broadcast has arrived, so a late-resolving
  // initial-state load cannot clobber it with a stale snapshot.
  const partyBroadcastSeen = useRef(false);
  // Members with an in-flight session start, and members already prewarmed once.
  const startingRef = useRef<Set<string>>(new Set());
  // Last reported prewarm failure per member, so the retry cadence reports each
  // distinct reason once instead of repeating the same notice every attempt.
  const prewarmFailureRef = useRef<Map<string, string>>(new Map());
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
  // A session may emit before the party broadcast binds its id to a member, or
  // before that member's WSL transcript read completes. Keep those events in
  // memory until the persisted history has been merged. Only sessions recorded
  // in `transcriptOwnerBySessionRef` are allowed onto the persistence path.
  const pendingEventsBySessionRef = useRef<Record<string, any[]>>({});
  const transcriptOwnerBySessionRef = useRef<Map<string, string>>(new Map());

  // Publish the composer preferences to the input, which sits two layers down
  // (Workbench → Panel → Composer) and is the only consumer. App stays the sole
  // owner of settings state; see app/composerPrefs.ts.
  usePublishComposerPrefs(state.settings.composer);

  // Same arrangement for starred models: the catalog is opened from five
  // screens, so publishing beats threading a prop (and its callback) through
  // each of them. App still owns the state and performs the write.
  usePublishFavoriteModels(state.settings.favoriteModels, toggleFavoriteModel);

  // --- Font family (설정 → 글꼴) --------------------------------------------
  // Every surface already draws through `--font-sans` / `--font-mono` (see
  // design-system.css), so overriding the two variables on <html> is the whole
  // application step — no component needs to know a font setting exists.
  const fonts = state.settings.fonts;
  useEffect(() => {
    const selection = normalizeFontSettings(fonts);
    document.documentElement.style.setProperty("--font-sans", fontStackFor(selection.sans, "sans"));
    document.documentElement.style.setProperty("--font-mono", fontStackFor(selection.mono, "mono"));
  }, [fonts?.sans, fonts?.mono]);

  // Lets `GET /api/appearance/fonts` ask Chromium which families are installed.
  useEffect(() => { publishFontProbe(); }, []);

  // Lets a component too deep to hold notice state report one — today, a
  // transcript file link that could not be opened. See app/appNotice.ts.
  useNoticeSink(setPartyNotice);

  /**
   * The clock the sidebar's "3일 전" labels are measured against.
   *
   * Re-read on a minute, not on every render: without a tick the labels freeze
   * at whatever the app was opened with, and with `Date.now()` inline they would
   * make every render a different tree.
   */
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * Party groups and cwd preferences — app-global, so they are read from their
   * own registry rather than from the workspace snapshot.
   *
   * Re-read on every party change: creating, deleting or moving a party is what
   * changes the counts the sidebar draws, and the registry is the one place that
   * knows them for a party this window has not opened.
   */
  const [groupState, setGroupState] = useState<{ groups: PartyGroup[]; parties: RegisteredParty[] }>(
    () => ({ groups: [], parties: [] }),
  );
  const [cwdPrefs, setCwdPrefs] = useState<CwdPreferences>(EMPTY_CWD_PREFERENCES);
  /** Where the picker points when the user has neither a recent nor a default. */
  const [appWorkspaceRoot, setAppWorkspaceRoot] = useState("");
  /**
   * Installed distros for the WSL side of the cwd picker.
   *
   * `distros: undefined` until the first read lands, which the picker draws as
   * "reading" rather than "none installed" — telling those two apart is the
   * difference between "wait" and "go install WSL".
   */
  const [wslState, setWslState] = useState<{ distros?: string[]; error?: string }>({});

  const refreshGroups = useCallback(async () => {
    try {
      const result = await window.agentParty.listPartyGroups();
      setGroupState({ groups: result.groups || [], parties: result.parties || [] });
    } catch (error) {
      noticeOnFailure("파티 그룹 목록을 읽지 못했습니다")(error);
    }
  }, []);

  const refreshCwdPreferences = useCallback(async (check?: boolean) => {
    try {
      const result = await window.agentParty.getCwdPreferences(check ? { check: true } : undefined);
      setCwdPrefs(result.preferences);
      setAppWorkspaceRoot(result.appWorkspaceRoot || "");
    } catch (error) {
      noticeOnFailure("작업 위치 설정을 읽지 못했습니다")(error);
    }
  }, []);

  const refreshWslDistros = useCallback(async () => {
    try {
      const result = await window.agentParty.listWslDistros();
      // An error with an empty list is still an ANSWER — the picker shows it.
      setWslState({ distros: result.distros || [], error: result.error });
    } catch (error) {
      setWslState({ distros: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  /** The WSL side of the picker: which distros exist, and why not, if none. */
  const wslBrowsing = useMemo(() => ({ distros: wslState.distros, error: wslState.error }), [wslState]);

  useEffect(() => { void refreshGroups(); void refreshCwdPreferences(); void refreshWslDistros(); }, [refreshGroups, refreshCwdPreferences, refreshWslDistros]);
  // The party list changing is the only thing that moves these numbers.
  useEffect(() => { void refreshGroups(); }, [refreshGroups, state.party.parties, state.party.members]);

  /**
   * The default group always exists in the registry; this fallback covers only
   * the first render, before the first read lands, so the sidebar never draws a
   * list with no folder at all.
   */
  const partyGroups = groupState.groups.length
    ? groupState.groups
    : [{ id: DEFAULT_PARTY_GROUP_ID, name: "기본 그룹", kind: "default" as const, createdAt: "", updatedAt: "" }];

  const activePartyName = state.party.parties?.find((party) => party.id === state.party.currentPartyId)?.name ?? "";
  const [memberLocations, setMemberLocations] = useState<MemberLocationRow[]>([]);
  useEffect(() => {
    void window.agentParty.listMemberLocations()
      .then((result) => setMemberLocations(result.members || []))
      .catch(noticeOnFailure("멤버 실행 위치를 읽지 못했습니다"));
  }, [state.party.members, state.settings.workspacePath]);

  /** Members sitting on each environment's default cwd — counted, never guessed. */
  const cwdDefaultUsage = useMemo<Partial<Record<ExecutionEnv, number>>>(() => {
    const tally: Partial<Record<ExecutionEnv, number>> = {};
    for (const row of memberLocations) {
      const fallback = row.location.env === "wsl" ? cwdPrefs.wslDefault : cwdPrefs.windowsDefault;
      if (fallback && memberLocationsEqual(fallback, row.location)) {
        tally[row.location.env] = (tally[row.location.env] ?? 0) + 1;
      }
    }
    return tally;
  }, [memberLocations, cwdPrefs]);

  async function createPartyGroup(name: string) {
    try {
      const result = await window.agentParty.createPartyGroup(name);
      setGroupState({ groups: result.groups || [], parties: result.parties || [] });
    } catch (error) {
      noticeOnFailure("파티 그룹을 만들지 못했습니다")(error);
    }
  }

  async function movePartyToGroup(partyId: string, groupId: string) {
    try {
      const result = await window.agentParty.movePartyToGroup(partyId, groupId);
      setGroupState({ groups: result.groups || [], parties: result.parties || [] });
    } catch (error) {
      noticeOnFailure("파티를 옮기지 못했습니다")(error);
    }
  }

  async function renamePartyGroup(groupId: string, name: string) {
    try {
      const result = await window.agentParty.renamePartyGroup(groupId, name);
      setGroupState({ groups: result.groups || [], parties: result.parties || [] });
    } catch (error) {
      noticeOnFailure("그룹 이름을 바꾸지 못했습니다")(error);
    }
  }

  async function reorderPartyGroups(order: string[]) {
    try {
      const result = await window.agentParty.reorderPartyGroups(order);
      setGroupState({ groups: result.groups || [], parties: result.parties || [] });
    } catch (error) {
      noticeOnFailure("그룹 순서를 바꾸지 못했습니다")(error);
    }
  }

  /**
   * Deletes a group; its parties land in the default one.
   *
   * The count is reported back, because "the folder is gone" and "your six
   * parties are now in 기본 그룹" are different facts and only the second one
   * tells the user where to look.
   */
  async function removePartyGroup(groupId: string) {
    try {
      const result = await window.agentParty.removePartyGroup(groupId);
      setGroupState({ groups: result.groups || [], parties: result.parties || [] });
      if (result.moved > 0) {
        reportNotice(`그룹을 삭제했습니다. 파티 ${result.moved}개를 기본 그룹으로 옮겼습니다.`);
      }
    } catch (error) {
      noticeOnFailure("그룹을 삭제하지 못했습니다")(error);
    }
  }

  /**
   * Opens the real folder picker and hands back a location only when it is
   * usable. A path that failed its check is reported with the reason and NOT
   * returned, so it cannot be stored as the member's cwd.
   */
  const browseCwd = useCallback(async (env: ExecutionEnv, distro?: string): Promise<MemberExecutionLocation | null> => {
    try {
      const result = await window.agentParty.browseCwd(env, distro);
      if (result.cancelled || !result.location) {
        return null;
      }
      if (result.problem) {
        reportNotice(`${result.problem.message}: ${result.location.cwd}`);
        return null;
      }
      return result.location;
    } catch (error) {
      noticeOnFailure("폴더 선택기를 열지 못했습니다")(error);
      return null;
    }
  }, []);

  const applyCwdPreferences = (result: { preferences: CwdPreferences }) => setCwdPrefs(result.preferences);

  async function pickDefaultCwd(env: ExecutionEnv) {
    const picked = await browseCwd(env);
    if (!picked) {
      return;
    }
    await window.agentParty.setDefaultCwd(picked).then(applyCwdPreferences).catch(noticeOnFailure("기본 cwd를 저장하지 못했습니다"));
  }

  // The settings 진단 tab's "자세히" opens the same dialog the titlebar pill does.
  useUpdateDialogSink(useCallback(() => setUpdateModalOpen(true), []));

  // Announce a newly-found version ONCE. The titlebar pill is the durable
  // indicator; this toast exists so the user notices without watching it, and
  // re-announcing the same version on every re-check would be nagging.
  const announcedUpdate = useRef("");
  useEffect(() => {
    const version = updateStatus?.state === "available" ? updateStatus.latestVersion || "" : "";
    if (version && announcedUpdate.current !== version) {
      announcedUpdate.current = version;
      setPartyNotice(updateStatus?.downgrade
        // A recalled release is not an upgrade, and saying "새 버전" about a
        // rollback would have the user install it expecting the opposite.
        ? `배포자가 최신 릴리스를 회수했습니다. 이전 버전 ${version} 으로 되돌릴 수 있습니다 — 제목 표시줄의 배지에서 진행하세요.`
        : `새 버전 ${version} 이(가) 있습니다. 제목 표시줄의 업데이트 배지에서 받을 수 있습니다.`);
    }
  }, [updateStatus?.state, updateStatus?.latestVersion, updateStatus?.downgrade]);

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

  // Load the active party's stored tab layout. Stamped with the party it is FOR:
  // a switch can outrun this reply, and applying the previous party's tabs to
  // the new one would silently reopen members from the party just left.
  const activePartyId = state.party.currentPartyId;
  // A party switch leaves Workbench's previous layout mounted for one render.
  // Scope its callbacks so same-named members (every party has `main`) cannot
  // make the new party restore the old party's tabs before its layout arrives.
  const visibleMembers = visibleMemberScope.partyId === activePartyId ? visibleMemberScope.names : [];
  const revealedMembers = useMemo(
    () => new Set(revealedMemberScope.partyId === activePartyId ? revealedMemberScope.names : []),
    [activePartyId, revealedMemberScope],
  );
  useEffect(() => {
    if (!activePartyId) {
      return;
    }
    let cancelled = false;
    void window.agentParty.getPartyLayout().then(
      (layout) => { if (!cancelled) setPartyLayout({ partyId: activePartyId, layout }); },
      // No stored layout is normal; a real failure must not leave the workbench
      // waiting forever for a reply that never comes — seed from the members.
      () => { if (!cancelled) setPartyLayout({ partyId: activePartyId }); },
    );
    return () => { cancelled = true; };
  }, [activePartyId]);

  // A restored transcript becomes renderable one panel at a time. This applies
  // to both cold reads and cached warm returns; without the second case, going
  // back to a six-panel party remounted all 900 cards in one blocking commit.
  useEffect(() => {
    const available = new Set(members
      .filter((member) => restoredByMember[memberKey(member)] !== undefined)
      .map((member) => member.name));
    const nextName = nextTranscriptReveal(visibleMembers, revealedMembers, available);
    if (!nextName || !activePartyId) return;

    const timer = window.setTimeout(() => {
      setRevealedMemberScope((current) => {
        const names = current.partyId === activePartyId ? current.names : [];
        return names.includes(nextName)
          ? current
          : { partyId: activePartyId, names: [...names, nextName] };
      });
    }, PROGRESSIVE_TRANSCRIPT_GAP_MS);
    return () => clearTimeout(timer);
  }, [activePartyId, members, restoredByMember, revealedMembers, visibleMembers]);

  const views = useMemo<MemberView[]>(
    () => members.map((member) => buildMemberView({
      member,
      sessions,
      transcriptBySession: logsBySession,
      subagentsBySession,
      seenCount: seenLengths[member.name] ?? 0,
      restored: restoredByMember[memberKey(member)],
      transcriptReady: revealedMembers.has(member.name),
      routes,
      compactDefault: state.settings.compactDefault,
      compacting: compactingByMember[member.name],
    })),
    [members, sessions, logsBySession, subagentsBySession, seenLengths, restoredByMember, revealedMembers, routes, state.settings.compactDefault, compactingByMember],
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
    const offer = state.guideOffer;
    if (!offer || guideOfferHandled.current) {
      return;
    }
    const action = nextGuideOfferAction(offer.pending, hasConnectedAccount(state.auth));
    if (action === "idle") {
      return;
    }
    if (action === "auth") {
      setCurrentView("auth");
      return;
    }
    guideOfferHandled.current = true;
    setGuideOfferOpen(true);
    void window.agentParty.markGuideOfferShown().then((next) => {
      setState((current) => ({ ...current, guideOffer: next }));
    }).catch((error) => {
      setPartyNotice(`가이드 안내를 기록하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [state.guideOffer, state.auth]);

  useEffect(() => {
    void window.agentParty.getInitialState().then((next) => {
      // If a party broadcast already arrived, keep it (avoid the load race).
      setState((current) => (partyBroadcastSeen.current ? { ...next, party: current.party } : next));
      if (next.sessions?.[0]) {
        setActiveSessionId(next.sessions[0].id);
      }
    });

    const offEvents = window.agentParty.onSessionEvents((payload: any) => {
      const sessionId = String(payload?.sessionId || "");
      const events = Array.isArray(payload?.events) ? payload.events : [];
      if (!sessionId || !events.length) {
        return;
      }
      // Subagent state is independent of transcript restoration, so fold it
      // immediately even while the parent member's conversation is gated.
      setSubagentsBySession((current) => applySubagentEvents(current, sessionId, events));
      // Do not assemble an unowned live transcript. If it were saved after the
      // party update attached this session to a member, it could replace that
      // member's not-yet-restored history with only these new events.
      if (!transcriptOwnerBySessionRef.current.has(sessionId)) {
        pendingEventsBySessionRef.current[sessionId] = [
          ...(pendingEventsBySessionRef.current[sessionId] || []),
          ...events,
        ];
        return;
      }
      setLogsBySession((current) => {
        return applyEvents(current, sessionId, events);
      });
    });
    const offSnapshot = window.agentParty.onSnapshot((payload: any) => {
      setState((current) => {
        const sessions = updateRendererSessionSnapshot(current.sessions, payload.sessionId, payload.snapshot);
        return sessions === current.sessions ? current : { ...current, sessions };
      });
    });
    const offSessions = window.agentParty.onSessions((payload) => {
      const incoming = payload as SessionView[];
      setState((current) => {
        const sessions = mergeRendererSessions(current.sessions, incoming);
        return sessions === current.sessions ? current : { ...current, sessions };
      });
      const next = incoming;
      setActiveSessionId((current) => (current && next.some((session) => session.id === current) ? current : next[0]?.id || ""));
    });
    const offPartyUpdate = window.agentParty.onPartyUpdate((payload) => {
      const party = payload as InitialAppState["party"];
      partyBroadcastSeen.current = true;
      setState((current) => ({ ...current, party }));
    });
    // Another window on this party moved its tabs. Same process, same party, so
    // this window shows the same thing rather than keeping its own stale copy.
    const offPartyLayout = window.agentParty.onPartyLayout((payload) => {
      setPartyLayout({ partyId: payload.partyId, layout: payload.layout });
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
    const offQaOpenGate = window.agentParty.onQaOpenGate?.((payload) => {
      const { kind, member } = (payload as { kind?: "member" | "party"; member?: string }) || {};
      setGateOpenRequest({ kind: kind === "party" ? "party" : "member", member: member || "", nonce: Date.now() });
      setCurrentView("workbench");
    });
    const offSettingsUpdate = window.agentParty.onSettingsUpdate?.((payload) => {
      const incoming = payload as InitialAppState["settings"];
      if (incoming.cwdPreferences) {
        setCwdPrefs(incoming.cwdPreferences);
      }
      setState((current) => ({ ...current, settings: { ...current.settings, ...incoming, workspacePath: current.settings.workspacePath } }));
    });
    // The group registry is app-global: a create/rename/delete/move in another
    // window (or over the HTTP API) must reach this one, or the sidebar keeps
    // showing folders that are gone.
    const offPartyGroups = window.agentParty.onPartyGroupsUpdate?.(() => { void refreshGroups(); });
    const offAuthUpdate = window.agentParty.onAuthUpdate?.((payload) => {
      setState((current) => ({ ...current, auth: payload as InitialAppState["auth"] }));
    });
    const offNativeCliAuthProgress = window.agentParty.onNativeCliAuthProgress?.((payload) => {
      setState((current) => ({ ...current, auth: applyNativeCliAuthProgress(current.auth, payload as NativeCliAuthProgress) }));
    });
    // The push sends the raw snapshot; the initial fetch wraps it in `{ usage }`.
    const offUsageUpdate = window.agentParty.onUsageUpdate?.((payload) => setUsageLimits((payload as UsageLimitsSnapshot) || {}));
    void window.agentParty.getUsageLimits?.().then((res) => { if (res?.usage) setUsageLimits(res.usage); });
    // App update: the push sends the bare status, the fetch wraps it in `{ update }`.
    const offUpdateStatus = window.agentParty.onUpdateStatus?.((payload) => setUpdateStatus(payload));
    void window.agentParty.getUpdateStatus?.().then((res) => { if (res?.update) setUpdateStatus(res.update); });
    // Discord bridge status: pushed on every state change (connect/error), and
    // fetched once at load so Settings shows the stored credentials immediately.
    const offDiscordUpdate = window.agentParty.onDiscordUpdate?.((payload) => setDiscord(payload as DiscordBridgeStatus));
    void window.agentParty.getDiscordStatus?.().then((status) => setDiscord(status as DiscordBridgeStatus));
    const offNavigate = window.agentParty.onNavigate(({ view, tab, harness }) => {
      if (!isViewId(view)) return;
      setCurrentView(view);
      // A counter, not the id alone: asking for the tab you are already on must
      // still move the screen there after the user clicked elsewhere.
      if (view === "agent" && tab && isAgentTabId(tab)) {
        const picked = harness && (HARNESS_IDS as readonly string[]).includes(harness) ? (harness as HarnessId) : undefined;
        setAgentTabRequest((current) => ({ tab, harness: picked, seq: current.seq + 1 }));
      } else if (view === "settings" && tab && isSettingsTabId(tab)) {
        setSettingsTabRequest((current) => ({ tab, seq: current.seq + 1 }));
      }
    });
    const offWorkspaceChoose = window.agentParty.onWorkspaceChoose(() => { void chooseWorkspace(); });
    const offNewSession = window.agentParty.onNewSession(() => { void createParty(); setCurrentView("workbench"); });
    return () => {
      offEvents();
      offSnapshot();
      offSessions();
      offPartyUpdate();
      offPartyLayout();
      offModelsUpdate();
      offSettingsUpdate?.();
      offDiscordUpdate?.();
      offPartyGroups?.();
      offAuthUpdate?.();
      offNativeCliAuthProgress?.();
      offUsageUpdate?.();
      offUpdateStatus?.();
      offQaLayout();
      offQaOpenSub();
      offQaOpenGate?.();
      offNavigate();
      offWorkspaceChoose();
      offNewSession();
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

  /**
   * Members whose history this window needs in memory.
   *
   * NOT the whole party. A transcript is capped at 800 blocks but a block can be
   * a whole tool output, so one member's file reaches ~15MB on disk and several
   * times that once parsed into JS objects and React elements. Loading every
   * member of the party made each window pay for the party's entire history —
   * and three windows on one party paid for it three times over.
   *
   * A member qualifies when it is FRONTMOST in a panel or when it holds a LIVE
   * SESSION. A background tab is restored when selected instead of competing
   * with the visible party switch. The live-session case is not about display:
   * events for a session whose
   * transcript has no owner queue in `pendingEventsBySessionRef` forever, so
   * skipping a live member's restore would trade bounded history for an
   * unbounded buffer.
   */
  const transcriptMembers = useMemo(() => {
    const wanted = new Set(visibleMembers);
    for (const member of members) {
      if (member.sessionId) {
        wanted.add(member.name);
      }
    }
    return wanted;
  }, [visibleMembers, members]);

  // Restore each needed member's persisted transcript from disk once, so a
  // reopened app (or a closed member) shows its past conversation. Visible
  // members are fetched FIRST, one per event-loop yield, before any non-visible
  // live sessions that still need an event/persistence owner.
  // The old loop fired every IPC read at once; React then batched several large
  // replies into one multi-panel commit. A six-panel/20-tab party consequently
  // parsed all 27 MiB and mounted 900 cards before the loading layout could
  // respond. Sequential restoration makes the focused panel usable first and
  // lets the remaining panels fill without one long main-thread stall.
  // `restoredByMember[key]` stays UNDEFINED until the fetch settles — it is the
  // "restore completed" signal the save effect below gates on. The old version
  // wrote a `[]` sentinel up front, so a session whose first events arrived
  // before the (slow, e.g. WSL-remote) fetch resolved was never seeded, and the
  // debounced save then overwrote the on-disk transcript with just the new
  // session's blocks — losing the member's whole history (SEL-6910 incident).
  const [restoreRetryNonce, setRestoreRetryNonce] = useState(0);
  const restoreRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const wanted = members.filter((member) => transcriptMembers.has(member.name));
    const readyButHidden = visibleMembers.some((name) => {
      const member = members.find((candidate) => candidate.name === name);
      return Boolean(member && restoredRef.current[memberKey(member)] !== undefined && !revealedMembers.has(name));
    });
    if (readyButHidden) return;
    const member = nextTranscriptRestore(
      wanted,
      visibleMembers,
      (candidate) => restoredRef.current[memberKey(candidate)] !== undefined,
      (candidate) => restoreRequestedRef.current.has(memberKey(candidate)),
    );
    if (!member) return;

    // A short task yield gives Chromium an opportunity to paint and service
    // input before transcript parsing and the next React commit begin.
    const timer = window.setTimeout(() => {
      const key = memberKey(member);
      restoreRequestedRef.current.add(key);
      void window.agentParty.getMemberTranscript?.(member.name, member.partyId)?.then((raw) => {
        const blocks = Array.isArray(raw) ? normalizeTranscriptBlocks(raw as TranscriptBlock[]) : [];
        // Always record the result (even empty): it marks the restore as done.
        setRestoredByMember((current) => ({ ...current, [key]: blocks }));
      }).catch(() => {
        // Surface and retry — silently treating a failed read as "no history"
        // is what let the save path clobber the on-disk transcript.
        restoreRequestedRef.current.delete(key);
        setPartyNotice(`'${member.name}' 대화 기록 복원 실패 — 다시 시도합니다.`);
        setTimeout(() => setRestoreRetryNonce((n) => n + 1), 2000);
      });
    }, PROGRESSIVE_TRANSCRIPT_GAP_MS);
    return () => clearTimeout(timer);
  }, [members, visibleMembers, transcriptMembers, restoredByMember, revealedMembers, restoreRetryNonce]);

  // This is the single transition that makes a session transcript writable:
  // member identity is known AND its persisted transcript read has settled.
  // It also flushes events that arrived before either condition became true.
  useEffect(() => {
    for (const member of members) {
      if (!member.sessionId) {
        continue;
      }
      activateSessionTranscript(member.sessionId, member, restoredByMember[memberKey(member)]);
    }
  }, [members, restoredByMember]);

  // Serializes saves per member. Two overlapping saves for one member could land
  // out of order and persist the OLDER transcript last, so each member's saves
  // run in a chain; the delta is computed when a link actually runs.
  const saveChainRef = useRef<Record<string, Promise<void>>>({});

  /**
   * Keeps this window's "what is on disk" mirror in step with what it renders.
   *
   * A window no longer WRITES the transcript — the main process folds the same
   * event stream and persists it once (see `recordTranscriptEvents`). This exists
   * because the writer used to be a property of the UI, which meant two windows
   * on one member wrote the same file twice and fought over the append anchor,
   * and a member driven with no window open was never written at all. Both are
   * gone once the writer follows the session rather than the view.
   *
   * The mirror still matters here: `restoredByMember` is what a member shows
   * before (or without) a live session, so leaving it stale would make a
   * reopened tab flash old history.
   */
  const persistTranscript = useCallback(async (name: string, key: string, blocks: TranscriptBlock[]) => {
    setRestoredByMember((current) => (current[key] === blocks ? current : { ...current, [key]: blocks }));
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
        // would overwrite (lose) it. Once restored resolves, the activation
        // transition above folds history and early events together atomically.
        if (restoredRef.current[key] === undefined) {
          continue;
        }
        // Restore completion alone is insufficient: a newly assigned sessionId
        // may already hold events received before the party broadcast. Persist
        // only after activateSessionTranscript merged those with this member's
        // restored history under the same concrete member identity.
        if (!member.sessionId || transcriptOwnerBySessionRef.current.get(member.sessionId) !== key) {
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

  /**
   * `.catch` handler for an action dispatched as `void promise`.
   *
   * Nearly every mutation on this screen is fired from an event handler and left
   * unawaited, so a rejection became an UNHANDLED rejection — recorded in the log
   * and by the crash handler, yet invisible to the person who just clicked.
   * Party creation was the clearest case: the name field clears exactly as it
   * does on success, so a failed create read as "done" and the party simply
   * never appeared. Routing these through the existing notice toast is what
   * turns "the app ignored me" into a sentence the user can act on.
   *
   * `what` names the USER'S action, never the IPC channel.
   */
  const noticeOnFailure = useCallback(
    (what: string) => (error: unknown) => setPartyNotice(`${what}: ${ipcErrorMessage(error)}`),
    [],
  );

  /**
   * An approval card can outlive the request behind it — the turn ends, the
   * member respawns, or someone answered it on a phone. The click used to
   * report nothing in those cases while the card visibly flipped to "resolved",
   * so the user believed they had answered.
   */
  const noticeIfNotDelivered = useCallback((delivery: ApprovalDelivery) => {
    if (delivery === "no_such_session") {
      setPartyNotice("이 승인 요청의 세션이 이미 종료되어 응답이 전달되지 않았습니다.");
    } else if (delivery === "not_pending") {
      setPartyNotice("이미 처리되었거나 만료된 승인 요청입니다. 응답이 전달되지 않았습니다.");
    }
  }, []);

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

  async function createParty(input?: Partial<CreatePartyInput>) {
    try {
      const result = await window.agentParty.createParty({
        name: (input?.name ?? "").trim() || "새 파티",
        gate: input?.gate,
        groupId: input?.groupId,
        location: input?.location ? serializeMemberLocation(input.location) : undefined,
      });
      await applyPartyResult(result);
      setCurrentView("workbench");
    } catch (error) {
      // The sidebar clears its input on submit, which is indistinguishable from
      // success — so a swallowed failure here read as "the party was created"
      // while the list stayed empty.
      noticeOnFailure("파티를 만들지 못했습니다")(error);
    }
  }

  /** Selects from the Windows-global party store without changing this window's cwd. */
  async function selectParty(partyId: string) {
    try {
      // Main validates the global row and returns the selected party atomically,
      // so a stale sidebar row cannot partially change renderer state.
      const result = await window.agentParty.selectParty(partyId);
      await applyPartyResult(result, true, result.switchedState);
    } catch (error) {
      noticeOnFailure("파티를 전환하지 못했습니다")(error);
    }
  }

  /**
   * Opens a party in ANOTHER window of this same process.
   *
   * Deliberately does not select the party here — this window stays where it is,
   * which is the whole point of running several parties side by side. The new
   * window shares this process's engine and sessions, so a member already
   * running is reused rather than started a second time (the duplication that
   * separate app processes used to cause).
   */
  async function openPartyInNewWindow(partyId: string) {
    try {
      // The main process owns the authoritative workspace for this renderer's
      // BrowserWindow. Do not forward settings.workspacePath here: settings are
      // shared across windows and may now point at a different window's cwd.
      await window.agentParty.newWindow?.(undefined, partyId);
    } catch (error) {
      setPartyNotice(`새 창을 열지 못했습니다 — ${error instanceof Error ? error.message : String(error)}`);
    }
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

  /**
   * One Authentication card per API-key provider. The save/test call is picked
   * by provider id — an unknown id is surfaced instead of being written to
   * whichever provider happens to be first.
   */
  const API_KEY_ACTIONS: Record<string, {
    save: (value: string) => Promise<InitialAppState["auth"]>;
    test: () => Promise<InitialAppState["auth"]>;
    clear: () => Promise<InitialAppState["auth"]>;
  }> = {
    openrouter: {
      save: (value) => window.agentParty.setOpenRouterKey(value),
      test: () => window.agentParty.testOpenRouterKey(),
      clear: () => window.agentParty.clearOpenRouterKey(),
    },
    deepseek: {
      save: (value) => window.agentParty.setDeepseekKey(value),
      test: () => window.agentParty.testDeepseekKey(),
      clear: () => window.agentParty.clearDeepseekKey(),
    },
  };

  async function saveApiKey(providerId: string) {
    const value = (apiKeyDrafts[providerId] || "").trim();
    const actions = API_KEY_ACTIONS[providerId];
    if (!value || !actions) {
      return;
    }
    const auth = await actions.save(value);
    setApiKeyDrafts((current) => ({ ...current, [providerId]: "" }));
    setState((current) => ({ ...current, auth }));
  }

  async function testApiKey(providerId: string) {
    const actions = API_KEY_ACTIONS[providerId];
    if (!actions) {
      return;
    }
    const auth = await actions.test();
    setState((current) => ({ ...current, auth }));
  }

  async function clearApiKey(providerId: string) {
    const actions = API_KEY_ACTIONS[providerId];
    if (!actions) {
      return;
    }
    const auth = await actions.clear();
    setApiKeyDrafts((current) => ({ ...current, [providerId]: "" }));
    setState((current) => ({ ...current, auth }));
  }

  async function testNativeCliAuth(provider: NativeCliAuthProvider, host: NativeCliAuthHost): Promise<NativeCliAuthTestResult> {
    const pending: NativeCliAuthProgress = {
      provider,
      host,
      checkedAt: new Date().toISOString(),
      phase: "pending",
      check: nativeCliAuthProgressCheck(provider, host, [], "pending"),
    };
    setState((current) => ({ ...current, auth: applyNativeCliAuthProgress(current.auth, pending) }));
    // Give the browser one paint with every row unchecked before the main
    // process starts completing fast synchronous boundaries.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const result = await window.agentParty.testNativeCliAuth(provider, host);
    setState((current) => ({ ...current, auth: result.auth }));
    return result;
  }

  async function refreshParty() {
    const party = await window.agentParty.listParty();
    setState((current) => ({ ...current, party }));
  }

  async function applyPartyResult(result: PartyCommandResult, notify = true, baseState?: InitialAppState) {
    // `notify` is off for routine sends: a toast on every message ("Message sent
    // to 'X'.") is noise. State still updates; real send failures surface below.
    if (notify) {
      setPartyNotice(result.message);
    }
    if (result.members) {
      setState((current) => ({
        ...(baseState ?? current),
        party: {
          parties: result.parties || baseState?.party.parties || current.party.parties || [],
          currentPartyId: result.currentPartyId || baseState?.party.currentPartyId || current.party.currentPartyId,
          members: result.members || [],
          messages: result.messages || baseState?.party.messages || current.party.messages || [],
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

  async function createMemberInline(input: CreateMemberInput) {
    try {
      // The wizard owns an object-shaped location because it edits environment,
      // distro, and cwd independently. IPC/API own the serialized string shape.
      // Keep that conversion at the renderer boundary, exactly as party creation
      // does, so neither Windows nor WSL objects reach the string parser.
      const { location, ...member } = input;
      const result = await window.agentParty.createPartyMember({
        ...member,
        partyId: selectedParty?.id,
        location: location ? serializeMemberLocation(location) : undefined,
      });
      await applyPartyResult(result);
    } catch (error) {
      noticeOnFailure(`'${input.name}' 멤버를 만들지 못했습니다`)(error);
    }
  }

  // Direct removal for the Workbench sidebar, which owns its own confirm UI.
  async function removeMemberDirect(name: string) {
    try {
      const result = await window.agentParty.removePartyMember(name);
      await applyPartyResult(result);
    } catch (error) {
      noticeOnFailure(`'${name}' 멤버를 삭제하지 못했습니다`)(error);
    }
  }

  /**
   * Hands a tab layout this window produced to the main process, which persists
   * it and pushes it to the other windows on this party.
   *
   * The local copy is advanced too. Workbench remounts on every nav away and
   * back, and re-seeds from this value — left at whatever was fetched on load,
   * it would restore tabs the user has since closed. Advancing it does not cause
   * a re-seed loop: Workbench suppresses adopting a layout it just produced.
   *
   * Failures are logged rather than raised: losing a tab position must not
   * interrupt what the user is doing.
   */
  function persistPartyLayout(layout: WorkbenchLayout) {
    if (activePartyId) {
      setPartyLayout({ partyId: activePartyId, layout });
    }
    void window.agentParty.setPartyLayout(layout).catch((error: unknown) => {
      console.error("[layout] could not persist the tab layout", error);
    });
  }

  /**
   * Idle sleep, per member. All three notify: sleeping is routinely *refused*
   * (a turn in flight, background work, a queued message) and the refusal is
   * the whole answer — swallowing it would leave a member the user just told to
   * sleep sitting there with no stated reason.
   */
  async function setMemberKeepAwake(name: string, keepAwake: boolean) {
    await applyPartyResult(await window.agentParty.setMemberKeepAwake(name, keepAwake));
  }

  async function sleepMember(name: string) {
    await applyPartyResult(await window.agentParty.sleepPartyMember(name));
  }

  async function wakeMember(name: string) {
    await applyPartyResult(await window.agentParty.wakePartyMember(name));
  }

  // Deletes a whole party (cascades to its members); the sidebar arms a confirm
  // click before calling this.
  async function removePartyDirect(partyId: string) {
    try {
      const result = await window.agentParty.deleteParty(partyId);
      await applyPartyResult(result);
    } catch (error) {
      noticeOnFailure("파티를 삭제하지 못했습니다")(error);
    }
  }

  async function toggleDebug(enabled: boolean) {
    const settings = await window.agentParty.updateSettings({ debugEnabled: enabled });
    setState((current) => ({ ...current, settings }));
  }

  async function saveCompactDefault(setting: AutoCompactSetting) {
    const settings = await window.agentParty.updateSettings({ compactDefault: setting });
    setState((current) => ({ ...current, settings }));
  }

  /**
   * Executable overrides from the environment tab. An EMPTY value is saved as
   * empty rather than skipped — that is how a user undoes a wrong path and
   * returns the harness to auto-discovery.
   */
  /**
   * Collapses, expands or resizes one sidebar drawer.
   *
   * Goes through the settings route rather than `localStorage` so the same call
   * an agent makes over `POST /api/settings` moves the real UI, and so a second
   * window is told about it instead of drifting until reload.
   */
  async function saveDrawer(which: SidebarDrawerId, patch: Partial<SidebarDrawerState>) {
    const current = state.settings.sidebarDrawers || DEFAULT_SIDEBAR_DRAWERS;
    const settings = await window.agentParty.updateSettings({
      sidebarDrawers: { ...current, [which]: { ...current[which], ...patch } },
    });
    setState((existing) => ({ ...existing, settings }));
  }

  async function saveExecutablePaths(patch: Partial<InitialAppState["settings"]>) {
    const settings = await window.agentParty.updateSettings(patch);
    setState((current) => ({ ...current, settings }));
  }

  async function saveLocale(locale: AppLocale) {
    try {
      const settings = await window.agentParty.setLocale(locale);
      setState((current) => ({ ...current, settings }));
    } catch (error) {
      setPartyNotice(t("runtime.language.saveError", { error: ipcErrorMessage(error) }));
    }
  }

  /**
   * Persisting this also pushes the new policy to every engine (local and WSL),
   * so turning sleep off stops the sweep on members this window is not showing.
   */
  async function saveIdleSleep(setting: IdleSleepSettings) {
    const settings = await window.agentParty.updateSettings({ idleSleep: setting });
    setState((current) => ({ ...current, settings }));
  }

  async function saveGateDefault(reviewer: GateReviewer) {
    const settings = await window.agentParty.updateSettings({ gateDefaults: reviewer });
    setState((current) => ({ ...current, settings }));
  }

  /**
   * Edits one section of the member primer. Goes through the controller (not a
   * raw settings patch) so the UI and `POST /api/party/primer` share the same
   * validation — an unknown section or a disabled required section is refused
   * there rather than silently stored.
   */
  /**
   * Translates one primer section (or clears its translation). Unlike the other
   * settings writes this one can fail slowly and for external reasons (no
   * subscription connected, proxy down), so the error is thrown back to the card
   * that asked for it and shown there — not swallowed into a corner toast.
   */
  async function translatePartyPrimerSection(patch: { section: PartyPrimerSectionId; clear?: boolean }) {
    const result = await window.agentParty.translatePartyPrimerSection(patch);
    setState((current) => ({ ...current, settings: result.settings }));
  }

  async function savePartyPrimerSection(patch: PartyPrimerSectionPatch) {
    try {
      const result = await window.agentParty.savePartyPrimerSection(patch);
      setState((current) => ({ ...current, settings: result.settings }));
    } catch (error) {
      noticeOnFailure("파티 프롬프트를 저장하지 못했습니다")(error);
    }
  }

  /**
   * Stars/unstars a model. Persisted immediately and independently of the
   * catalog's Apply button: tidying a list is not a runtime change, so it must
   * neither wait on Apply nor be discarded by Cancel.
   */
  async function toggleFavoriteModel(id: string) {
    const favoriteModels = nextFavoriteModels(state.settings.favoriteModels || [], id);
    const settings = await window.agentParty.updateSettings({ favoriteModels });
    setState((current) => ({ ...current, settings }));
  }

  /** Persists a message-input preference (send key). */
  async function saveComposerSettings(patch: Partial<ComposerSettings>) {
    const settings = await window.agentParty.updateSettings({ composer: { ...state.settings.composer, ...patch } });
    setState((current) => ({ ...current, settings }));
  }

  async function saveFonts(patch: Partial<FontSettings>) {
    const settings = await window.agentParty.updateSettings({ fonts: { ...normalizeFontSettings(state.settings.fonts), ...patch } });
    setState((current) => ({ ...current, settings }));
  }

  async function saveMemberMessaging(patch: Partial<MemberMessagingSettings>) {
    const settings = await window.agentParty.updateSettings({ memberMessaging: { ...state.settings.memberMessaging, ...patch } });
    setState((current) => ({ ...current, settings }));
  }

  async function saveDiscordSettings(patch: { desktopName?: string; botToken?: string; guildId?: string; allowedUserIds?: string[] }) {
    setDiscord(await window.agentParty.updateDiscordSettings(patch) as DiscordBridgeStatus);
  }

  // --- Workbench actions (addressed by member name) -----------------------
  function sessionIdFor(name: string): string | undefined {
    const sessionId = members.find((member) => member.name === name)?.sessionId;
    return sessionId && sessions.some((session) => session.id === sessionId) ? sessionId : undefined;
  }

  /**
   * Changes a member's permission through the MEMBER-scoped route, which
   * persists it and applies it to the live adapter when one is running.
   * The session-scoped setters only reach a live adapter, so driving them from
   * here dropped every change made while the member's session was down — the
   * control then snapped back to the stored value, read as "permission reset".
   */
  async function persistMemberPermission(name: string, permission: MemberPermissionInput): Promise<void> {
    try {
      await applyPartyResult(await window.agentParty.setMemberPermission(name, permission) as PartyCommandResult, false);
    } catch (error) {
      setPartyNotice(`'${name}' 권한을 변경하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
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

  async function disconnectSubscription(provider: "codex" | "claude" | "cursor") {
    try {
      const result = await window.agentParty.disconnectSubscription(provider);
      setState((current) => ({ ...current, auth: result.auth }));
      setPartyNotice(result.detail);
    } catch (error) {
      setPartyNotice(`구독 연결을 끊지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      const auth = await window.agentParty.listAuth();
      setState((current) => ({ ...current, auth }));
    }
  }

  /** Restored transcript for one concrete member identity, never name-only. */
  function restoredTranscriptFor(member?: PartyMember): TranscriptBlock[] | undefined {
    return member ? restoredRef.current[memberKey(member)] : undefined;
  }

  /**
   * Makes a session's transcript live only after its member history is restored.
   * Pending startup events are folded after the restored prefix, atomically from
   * the renderer's point of view, and the persistence gate opens last.
   */
  function activateSessionTranscript(sessionId: string, member: PartyMember, restored?: TranscriptBlock[]): void {
    if (restored === undefined) {
      return;
    }
    const ownerKey = memberKey(member);
    if (transcriptOwnerBySessionRef.current.get(sessionId) === ownerKey) {
      return;
    }
    // Snapshot and remove the pending batch outside React's functional updater.
    // Updaters may run more than once in Strict Mode and therefore must stay pure.
    const pending = pendingEventsBySessionRef.current[sessionId] || [];
    delete pendingEventsBySessionRef.current[sessionId];
    setLogsBySession((current) => {
      const merged = mergeRestoredTranscript(restored, current[sessionId] || []);
      const seeded = current[sessionId] === merged ? current : { ...current, [sessionId]: merged };
      return pending.length ? applyEvents(seeded, sessionId, pending) : seeded;
    });
    // JavaScript cannot interleave another event handler before this line, and
    // React applies subsequent setLogsBySession calls after the queued merge.
    // Persistence runs only after that state commits, so opening the gate here
    // cannot expose an unmerged transcript.
    transcriptOwnerBySessionRef.current.set(sessionId, ownerKey);
  }

  /**
   * Runs a compaction for a member and shows the transient toolbar spinner
   * (~1.4s, matching the design's icon swap). The spinner is cosmetic — the
   * actual context drop arrives via the snapshot; the auto-compact re-fire guard
   * is the arm/disarm ref, not this flag.
   *
   * Addressed by MEMBER, not by its session: a member released by idle sleep has
   * no session id here, and this used to refuse with "세션이 없어…" — a
   * conversation that plainly still exists and is exactly what compaction is
   * for. The backend wakes it and compacts.
   */
  function runCompact(name: string): void {
    void window.agentParty.compactPartyMember(name)
      .then((result) => applyPartyResult(result, false))
      .catch(noticeOnFailure("컨텍스트를 압축하지 못했습니다"));
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
  //
  // Reports its outcome instead of throwing. A rejected start used to escape as
  // an unhandled promise rejection — no notice, no log, no retry — which is how
  // a restored tab could sit open with no session while every message to that
  // member was undeliverable. `skipped` distinguishes a deliberate no-op (the
  // member is closed, or another start is already in flight) from a failure, so
  // callers only retry the latter.
  async function ensureSession(name: string, opts: { auto?: boolean } = {}): Promise<EnsureSessionResult> {
    const existing = sessionIdFor(name);
    if (existing) {
      return { sessionId: existing };
    }
    const member = members.find((item) => item.name === name);
    const identity = member ? memberKey(member) : name;
    if (startingRef.current.has(identity)) {
      return { skipped: true };
    }
    startingRef.current.add(identity);
    try {
      const draft = runtimeDrafts[name];
      const memberHarness = harnessForRuntime(member?.runtime);
      const memberRoute = findRoute(
        member?.model,
        routes.filter((route) => (route.harnessId || "claude-code") === memberHarness),
      );
      // The member already carries its harness's model/effort/permission (set at
      // creation from that harness's defaults); fall back to the same harness's
      // defaults if somehow unset. Provider is inferred from the model route.
      const harnessDefaults = harnessDefaultsOf(state.settings, memberHarness);
      const result = await window.agentParty.startPartyMember(name, {
        // Opportunistic starts must not resurrect a member closed meanwhile.
        auto: opts.auto,
        selectedProviderId: draft?.providerId || (memberRoute?.providerId as any),
        model: draft?.model || member?.model || harnessDefaults.model,
        effort: (draft?.effort as any) || (member?.effort as any) || harnessDefaults.effort,
        serviceTier: draft?.serviceTier || member?.serviceTier || harnessDefaults.serviceTier,
        permissionMode: (draft?.permissionMode as any) || (member?.permissionMode as any) || harnessDefaults.permissionMode,
        cursorPolicy: draft?.cursorPolicy || member?.cursorPolicy || harnessDefaults.cursorPolicy,
      });
      await applyPartyResult(result);
      // The engine deliberately skipped an auto-start on a closed member — an
      // intentional no-op, not a failure worth a notice.
      if (opts.auto && result.member?.status === "closed") {
        return { skipped: true };
      }
      // Seed the (resumed) session's transcript with the member's restored history
      // so the conversation continues visibly, matching the harness thread resume.
      const sid = result.session?.id;
      const owner = result.member || member;
      const restored = restoredTranscriptFor(owner);
      if (sid && owner) {
        activateSessionTranscript(sid, owner, restored);
      }
      if (!sid) {
        return { error: result.message || "엔진이 세션을 반환하지 않았습니다." };
      }
      return { sessionId: sid };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      startingRef.current.delete(identity);
    }
  }

  const actions: WorkbenchActions = {
    openEnvironmentSettings() {
      setCurrentView("settings");
      // A counter, not the id alone — same reason as the navigation IPC above:
      // asking for a tab you are already on must still move the screen there.
      setSettingsTabRequest((current) => ({ tab: "environment", seq: current.seq + 1 }));
    },
    async sendMessage(name, text, attachments, options) {
      // Optimistic echo when the member already has a live session (instant feel);
      // for a not-yet-started member the echo is appended once the shared send
      // path returns its session id below.
      const known = sessionIdFor(name);
      const echoId = crypto.randomUUID();
      if (known) {
        setLogsBySession((current) => appendBlock(current, known, { id: echoId, kind: "user", text, attachments, at: nowTime() }));
      }
      // Same route as the HTTP API: the backend ensures the member's session
      // (starting it with the member's own config if needed) and delivers the
      // user turn. UI and agents go through the identical AppController method.
      // `interrupt` is the composer's preference: OFF queues behind the member's
      // in-flight turn, ON stops it so this message is handled now. The backend
      // never interrupts a compaction, and an idle member is unaffected. A
      // caller may override it for one send (Ctrl/Cmd+Enter's "지금 보내기"),
      // which is why this is `??` and not an `||` on a boolean.
      const result = await window.agentParty.sendMemberMessage(name, text, attachments, {
        interrupt: options?.interrupt ?? state.settings.composer?.interruptOnSend === true,
      });
      await applyPartyResult(result, false);
      if (result.queued) {
        // The member was busy, so this is WAITING — not sent. It belongs in the
        // queue list, not mixed into the conversation ahead of replies the agent
        // wrote before it ever saw the message. Retract the optimistic echo; the
        // `queue_dequeued` event puts the bubble back at the moment of delivery.
        if (known) {
          setLogsBySession((current) => removeBlock(current, known, echoId));
        }
        return result;
      }
      const sessionId = result.member?.sessionId || known;
      if (!sessionId) {
        setPartyNotice(`'${name}' 세션을 시작하지 못했습니다.`);
        return result;
      }
      if (!known) {
        // Freshly started: seed the restored history, then echo the just-sent turn.
        const owner = result.member || members.find((item) => item.name === name);
        const restored = restoredTranscriptFor(owner);
        if (owner) {
          activateSessionTranscript(sessionId, owner, restored);
        }
        setLogsBySession((current) => appendBlock(current, sessionId, { id: crypto.randomUUID(), kind: "user", text, attachments, at: nowTime() }));
      }
      return result;
    },
    async runQueueCommand(name, command) {
      // Deliberately NOT swallowed here. The queue panel shows the failure, and
      // the likeliest failure — the item was delivered a moment ago — is exactly
      // what the user needs to be told.
      const result = await window.agentParty.runQueueCommand(name, command);
      await applyPartyResult(result, false);
      return result;
    },
    prewarm(name) {
      // Init the visible member ahead of the first turn. Panel owns WHEN to try
      // (on activation/remount, and the retry cadence); ensureSession only
      // deduplicates an in-flight start. A lifetime "already prewarmed" set made
      // a member impossible to reopen after its session disappeared or after
      // switching between parties that both contain `main`: only sending a chat
      // could revive it.
      // Read through the ref, not the captured list: the panel effect that calls
      // this excludes `actions` from its deps, so a closure from before the
      // party update would still see the member as running and prewarm it. The
      // engine refuses an auto-start on a sleeping member regardless — this only
      // saves the pointless round trip.
      const member = membersRef.current.find((item) => item.name === name);
      // `sleeping` is skipped for the same reason as `closed`, from the other
      // direction: the app JUST released that process to reclaim memory, and an
      // open tab counts as neither a reason to keep it nor a request to wake it.
      // Prewarming it would restart the process within a tick of it sleeping and
      // idle sleep would never hold. Waking is driven by a message or an
      // explicit wake, both of which mean someone actually wants the member.
      // A member still bound to a session this process cannot see is running
      // under a sibling app process; the engine refuses to clone it, so asking
      // is pointless. `missing_session` is the exception and the reason this is
      // not just "has a sessionId": that status is the app's own statement that
      // the binding is DEAD, so the member does need starting again.
      const boundElsewhere = Boolean(member?.sessionId) && member?.status !== "missing_session";
      if (sessionIdFor(name) || boundElsewhere || member?.status === "closed" || member?.status === "sleeping" || member?.externalCli) {
        return;
      }
      void ensureSession(name, { auto: true }).then((result) => {
        if (result.sessionId || result.skipped) {
          prewarmFailureRef.current.delete(name);
          return;
        }
        // Say WHY, and say it once per distinct reason. The panel keeps retrying
        // on a widening delay, so a repeated notice would be noise — but a
        // silent failure was worse: the tab looked ready while every message to
        // the member was undeliverable.
        const reason = result.error || "엔진이 세션을 반환하지 않았습니다.";
        if (prewarmFailureRef.current.get(name) === reason) {
          return;
        }
        prewarmFailureRef.current.set(name, reason);
        setPartyNotice(`'${name}' 세션을 준비하지 못했습니다: ${reason} 자동으로 다시 시도합니다.`);
      }).catch(noticeOnFailure(`'${name}' 세션을 준비하지 못했습니다`));
    },
    approve(name, requestId, behavior, updatedInput) {
      const sessionId = sessionIdFor(name);
      if (!sessionId) {
        return;
      }
      void window.agentParty.approve(sessionId, requestId, behavior, updatedInput)
        .then(noticeIfNotDelivered)
        .catch(noticeOnFailure("승인 결과를 전달하지 못했습니다"));
      setLogsBySession((current) => markApprovalResolved(current, sessionId, requestId, behavior));
    },
    answerQuestion(name, requestId, input, answers) {
      const sessionId = sessionIdFor(name);
      if (!sessionId) {
        return;
      }
      const updatedInput = { ...(input && typeof input === "object" ? input : {}), answers };
      void window.agentParty.approve(sessionId, requestId, "allow", updatedInput)
        .then(noticeIfNotDelivered)
        .catch(noticeOnFailure("승인 결과를 전달하지 못했습니다"));
      setLogsBySession((current) => markApprovalResolved(current, sessionId, requestId, "allow", answers));
    },
    interrupt(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.interrupt(sessionId).catch(noticeOnFailure("중단하지 못했습니다"));
    },
    forceStop(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.forceStop(sessionId).catch(noticeOnFailure("강제 종료하지 못했습니다"));
    },
    restart(name) {
      const sessionId = sessionIdFor(name);
      if (sessionId) void window.agentParty.restart(sessionId).catch(noticeOnFailure("세션을 재시작하지 못했습니다"));
    },
    respawn(name) {
      // Reload the member's session while continuing the conversation
      // (respawnMember: restart + resume the same harness thread). Rebuilds from
      // the member's current config and re-reads MCP, so newly-added servers
      // take effect without losing context.
      void window.agentParty.respawnPartyMember(name).catch(noticeOnFailure(`'${name}' 세션을 재시작하지 못했습니다`));
    },
    compact(name) {
      runCompact(name);
    },
    setAutoCompact(name, setting) {
      // Persist through the shared party-action path; the party:update broadcast
      // reflects it back into every member view (toolbar pill + sidebar badge).
      // Re-arm the trigger so a fresh threshold takes effect immediately.
      autoArmedRef.current[name] = true;
      void window.agentParty.setMemberAutoCompact(name, setting ?? null).catch(noticeOnFailure(`'${name}' auto-compact 설정을 저장하지 못했습니다`));
    },
    setMemberGate(name, patch) {
      // Persist through the shared party-action path; party:update reflects the
      // new effective gate into every member view + the gate manager.
      void window.agentParty.setMemberGate(name, patch).catch(noticeOnFailure(`'${name}' Message Gate 설정을 저장하지 못했습니다`));
    },
    setMemberOutboundInterrupt(name, value) {
      void window.agentParty.setMemberOutboundInterrupt(name, value ?? null).catch(noticeOnFailure(`'${name}' 메시지 인터럽트 기본값을 저장하지 못했습니다`));
    },
    setPartyGate(partyId, gate) {
      void window.agentParty.setPartyGate(partyId, gate).catch(noticeOnFailure("파티 Message Gate 설정을 저장하지 못했습니다"));
    },
    closeSession(name) {
      // Closing the tab tears down the member's session and marks it closed, so
      // it stops occupying context / provider usage. Addressed by member name
      // (not sessionId): a prewarmed-but-not-yet-bound member still gets closed,
      // and the closed status blocks auto-prewarm from resurrecting it.
      void window.agentParty.closePartyMember(name).catch(noticeOnFailure(`'${name}' 멤버를 닫지 못했습니다`));
    },
    async applyRuntime(name, runtime) {
      if (runtime.debug !== state.settings.debugEnabled) {
        await toggleDebug(runtime.debug);
      }
      const sessionId = sessionIdFor(name);
      const member = members.find((item) => item.name === name);
      // A route already carries its harness id — re-deriving it through a
      // ternary only created a chance to forget a harness (grok did not exist
      // when this was written, so a Grok route read as claude-code).
      const selectedHarness = (runtime.route?.harnessId as HarnessId | undefined) || "claude-code";
      const currentHarness = harnessForRuntime(member?.runtime);
      const grokEffortNeedsRestart = selectedHarness === "grok" && Boolean(runtime.effort) && runtime.effort !== member?.effort;
      if (runtime.route && (selectedHarness !== currentHarness || runtime.serviceTier !== member?.serviceTier || grokEffortNeedsRestart)) {
        // A harness is the adapter PROCESS, not model metadata. Recreate the
        // prewarmed session when the actual selected harness changes or when a
        // process-start setting changes. Grok Build consumes reasoning effort
        // as a CLI flag and has no ACP method for mutating it live.
        const result = await window.agentParty.respawnPartyMember(name, {
          selectedHarnessId: selectedHarness,
          selectedProviderId: runtime.route.providerId,
          model: runtime.route.model,
          effort: runtime.effort,
          serviceTier: runtime.serviceTier,
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
          serviceTier: runtime.serviceTier ?? current[name]?.serviceTier,
          thinking: runtime.thinkingMode ? runtime.thinkingMode !== "disabled" : current[name]?.thinking,
        },
      }));
    },
    setEffort(name, effort) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setEffort(sessionId, effort).catch(noticeOnFailure("추론 강도를 바꾸지 못했습니다"));
      }
      setRuntimeDrafts((current) => ({ ...current, [name]: { ...current[name], effort } }));
    },
    setThinking(name, mode, budget) {
      const sessionId = sessionIdFor(name);
      if (sessionId) {
        void window.agentParty.setThinking(sessionId, mode, budget).catch(noticeOnFailure("추론 모드를 바꾸지 못했습니다"));
      }
    },
    setCodexPolicy(name, policy) {
      void persistMemberPermission(name, { codexPolicy: policy });
    },
    setCursorPolicy(name, policy) {
      void persistMemberPermission(name, { cursorPolicy: policy });
      setRuntimeDrafts((current) => ({ ...current, [name]: { ...current[name], cursorPolicy: policy } }));
    },
    async listMcp(name) {
      const sessionId = sessionIdFor(name);
      const member = members.find((item) => item.name === name);
      const harness = harnessForRuntime(member?.runtime);
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
      void persistMemberPermission(name, { permissionMode: mode as PermissionModeSetting });
      setRuntimeDrafts((current) => ({ ...current, [name]: { ...current[name], permissionMode: mode } }));
    },
  };

  // The implementations above intentionally read the current render's state.
  // Panels need a stable object identity, though: otherwise one streamed delta
  // invalidates every memoized transcript even when only one member changed.
  // Delegates are stable while each invocation still reaches today's closure.
  const latestActionsRef = useRef(actions);
  latestActionsRef.current = actions;
  const stableActionsRef = useRef<WorkbenchActions | null>(null);
  if (!stableActionsRef.current) {
    stableActionsRef.current = createLatestMethodProxy(() => latestActionsRef.current);
  }
  const stableActions = stableActionsRef.current;

  /** Persists one harness's creation defaults (model/effort/reasoning/permission). */
  async function saveHarnessDefaults(harnessId: HarnessId, patch: Partial<HarnessDefaults>) {
    const current = state.settings.harnessDefaults[harnessId];
    const settings = await window.agentParty.updateSettings({
      harnessDefaults: { ...state.settings.harnessDefaults, [harnessId]: { ...current, ...patch } },
    });
    setState((prev) => ({ ...prev, settings }));
  }

  /** Sets which harness a brand-new member defaults to. */
  async function setDefaultHarness(harnessId: HarnessId) {
    const settings = await window.agentParty.updateSettings({ selectedHarnessId: harnessId });
    setState((prev) => ({ ...prev, settings }));
  }

  /**
   * The nav rail does NOT switch the view itself. It asks main, which checks the
   * account gate (§8) and then navigates this window — one path for the click
   * and for POST /api/guide/open, so an agent and a user land the same way.
   */
  async function openGuide() {
    try {
      await window.agentParty.openGuide();
    } catch (error) {
      setPartyNotice(`가이드를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // doctor will add "문제 해결" on the same rail; keep this list a flat append,
  // no new abstraction.
  const navItems: Array<{ id: ViewId; label: string; icon: JSX.Element }> = [
    { id: "workbench", label: viewTitle("workbench", t), icon: <Sparkles size={18} /> },
    { id: "guide", label: viewTitle("guide", t), icon: <BookOpen size={18} /> },
    { id: "usage", label: viewTitle("usage", t), icon: <BarChart3 size={18} /> },
    { id: "auth", label: viewTitle("auth", t), icon: <KeyRound size={18} /> },
    { id: "agent", label: viewTitle("agent", t), icon: <SlidersHorizontal size={18} /> },
    { id: "settings", label: viewTitle("settings", t), icon: <Settings size={18} /> },
  ];

  const isDark = theme.themeId === "dark";

  // Party members driving each harness subscription/account indicator. Models
  // routed through OpenRouter do not replace the selected harness process.
  const membersByProvider = useMemo<Partial<Record<UsageProviderId, number>>>(() => {
    const counts: Partial<Record<UsageProviderId, number>> = {};
    for (const member of members) {
      const provider = providerOfRuntime(member.runtime);
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
      onOpenSettings={() => setCurrentView("settings")}
      onRefresh={() => { void refreshUsageLimits(); }}
      refreshing={usageRefreshing}
    />
  );

  return (
    <I18nProvider locale={state.settings.locale}>
    {/* `data-workspace` is the execution/migration context the renderer has
        applied. Party selection is global and deliberately does not change it;
        QA uses this attribute to verify that separation. */}
    <div className="app-shell" data-workspace={state.settings.workspacePath}>
      <div className="app-titlebar">
        <div className="titlebar-drag">
          <div className="titlebar-brand"><span className="brand-mark"><span className="brand-mark-dot" /></span><span className="brand-name">AgentParty</span><small className="brand-sub">{viewTitle(currentView, t)}</small></div>
          <button type="button" className="titlebar-action no-drag" title={t("shell.theme")} onClick={theme.cycleTheme}>
            {isDark ? <Moon size={14} /> : <Sun size={14} />}
          </button>
          {/* Renders only when an update is actually pending — see UpdatePill. */}
          <span className="no-drag"><UpdatePill status={updateStatus} onOpen={() => setUpdateModalOpen(true)} /></span>
          {/* Renders only while a phone is connected — see MobileDrivingPill. */}
          {state.settings.mobile?.enabled === true && <span className="no-drag"><MobileDrivingPill /></span>}
        </div>
        <div className="window-controls">
          <button type="button" className="window-button" title={t("shell.minimize")} onClick={() => window.agentParty.minimizeWindow()}><Minus size={15} /></button>
          <button type="button" className="window-button" title={t("shell.maximize")} onClick={() => window.agentParty.maximizeWindow()}><Maximize2 size={14} /></button>
          <button type="button" className="window-button close" title={t("shell.close")} onClick={() => window.agentParty.closeWindow()}><X size={16} /></button>
        </div>
      </div>

      <div className="app-body">
        <nav className="nav-rail" aria-label={t("shell.navigation")}>
          <div className="nav-items">
            {navItems.map((item) => (
              <button key={item.id} data-view={item.id} className={"nav-item " + (currentView === item.id ? "active" : "")} onClick={() => { if (item.id === "guide") void openGuide(); else setCurrentView(item.id); }} title={item.label}>
                {item.icon}
              </button>
            ))}
          </div>
          <div className="nav-spacer" />
          <div className="nav-avatar" title={t("shell.account")}>JD</div>
        </nav>

        <main className="program-main">
          {currentView === "workbench" ? (
            <>
              <header className="screen-header">
                <div className="screen-title">
                  <h1>{viewTitle("workbench", t)}</h1>
                  {/* The PARTY, not the workspace path. Parties are app-global
                      now and every member runs in its own cwd, so the directory
                      the app was launched from described nothing on screen. */}
                  <span className="screen-party" title={activePartyName}>{activePartyName}</span>
                  <p>{t("shell.workbenchDescription")}</p>
                </div>
                <div className="screen-actions">
                  <button className="ghost-btn" onClick={chooseWorkspace}><FolderOpen size={15} /> {t("shell.workspace")}</button>
                  {usagePill}
                </div>
              </header>
              <Workbench
                parties={state.party.parties || []}
                activePartyId={state.party.currentPartyId}
                partyLayout={partyLayout}
                onPersistLayout={persistPartyLayout}
                views={views}
                routes={routes}
                codexModels={state.codexModels}
                onRefreshCodexModels={() => void window.agentParty.refreshCodexModels().catch(noticeOnFailure("Codex 모델 목록을 새로고침하지 못했습니다"))}
                defaultProfile={defaultMemberProfileOf(state.settings)}
                harnessDefaults={state.settings.harnessDefaults}
                gateDefaults={state.settings.gateDefaults}
                debugEnabled={state.settings.debugEnabled}
                drawers={drawers}
                layoutRequest={layoutRequest}
                subagentOpenRequest={subagentOpenRequest}
                gateOpenRequest={gateOpenRequest}
                actions={stableActions}
                groups={partyGroups}
                registeredParties={groupState.parties}
                cwdPrefs={cwdPrefs}
                appWorkspaceRoot={appWorkspaceRoot}
                now={nowTick}
                onCreateParty={(input) => void createParty(input)}
                onCreateGroup={(name) => void createPartyGroup(name)}
                onMovePartyToGroup={(partyId, groupId) => void movePartyToGroup(partyId, groupId)}
                onRenameGroup={(groupId, name) => void renamePartyGroup(groupId, name)}
                onRemoveGroup={(groupId) => void removePartyGroup(groupId)}
                onReorderGroups={(order) => void reorderPartyGroups(order)}
                onBrowseCwd={browseCwd}
                wsl={wslBrowsing}
                onCreateMember={(input) => void createMemberInline(input)}
                onRemoveMember={(name) => void removeMemberDirect(name)}
                onSetMemberKeepAwake={(name, keepAwake) => void setMemberKeepAwake(name, keepAwake)}
                onSleepMember={(name) => void sleepMember(name)}
                onWakeMember={(name) => void wakeMember(name)}
                onRemoveParty={(partyId) => void removePartyDirect(partyId)}
                onOpenPartyInNewWindow={(partyId) => void openPartyInNewWindow(partyId)}
                onSelectParty={(partyId) => void selectParty(partyId)}
                onMemberOpened={() => undefined}
                onVisibleMembersChange={(partyId, names) => setVisibleMemberScope({ partyId, names })}
                onToggleDrawer={(which, patch) => void saveDrawer(which, patch)}
                onOpenUsage={() => setCurrentView("usage")}
              />
            </>
          ) : currentView === "guide" ? (
            // Full bleed: the guide brings its own top row and its own body, and
            // a 작업공간 chip over a presentation would be noise.
            <GuideView onLeave={() => setCurrentView("workbench")} />
          ) : (
            <>
              <header className="screen-header">
                <div className="screen-title">
                  <h1>{viewTitle(currentView, t)}</h1>
                  <p>{viewSubtitle(currentView, t)}</p>
                  <div className="screen-chips">
                    <span className="screen-chip">
                      <FolderOpen size={13} />
                      <span className="wb-mono">
                        {state.workspace?.kind === "wsl" && <span className="host-badge" title={localized("STR-0825", [state.workspace.distro])}>WSL · {state.workspace.distro}</span>}
                        {state.workspace?.path || displayPath(state.settings.workspacePath) || t("shell.noWorkspace")}
                      </span>
                    </span>
                  </div>
                </div>
                <div className="screen-actions">
                  <button className="ghost-btn" onClick={chooseWorkspace}><FolderOpen size={15} /> {t("shell.workspace")}</button>
                  {usagePill}
                </div>
              </header>
              <div className="program-scroll">
              {currentView === "auth" && (
                <AuthView
                  auth={state.auth}
                  drafts={apiKeyDrafts}
                  onDraft={(providerId, value) => setApiKeyDrafts((current) => ({ ...current, [providerId]: value }))}
                  onSave={saveApiKey}
                  onTest={testApiKey}
                  onClear={clearApiKey}
                  onTestNativeCli={testNativeCliAuth}
                  onConnectSubscription={connectSubscription}
                  onDisconnectSubscription={disconnectSubscription}
                />
              )}
              {currentView === "agent" && (
                <AgentSettingsView
                  routes={routes}
                  settings={state.settings}
                  codexModels={state.codexModels}
                  onRefreshCodexModels={() => void window.agentParty.refreshCodexModels().catch(noticeOnFailure("Codex 모델 목록을 새로고침하지 못했습니다"))}
                  onSaveHarnessDefaults={saveHarnessDefaults}
                  onSetDefaultHarness={setDefaultHarness}
                  onSaveCompactDefault={saveCompactDefault}
                  onSaveIdleSleep={saveIdleSleep}
                  onSaveGateDefault={saveGateDefault}
                  onSavePartyPrimer={savePartyPrimerSection}
                  onTranslatePartyPrimer={translatePartyPrimerSection}
                  onSaveComposer={saveComposerSettings}
                  onSaveMemberMessaging={saveMemberMessaging}
                  discord={discord}
                  onSaveDiscord={saveDiscordSettings}
                  tabRequest={agentTabRequest}
                />
              )}
              {currentView === "usage" && (
                <TokenUsageView
                  usage={usageLimits}
                  parties={(state.party.parties || []).map((p) => ({ id: p.id, name: p.name }))}
                  onOpenMemberChat={(partyId, member) => {
                    if (partyId !== state.party.currentPartyId) { void selectParty(partyId); }
                    setCurrentView("workbench");
                    setPartyNotice(`'${member}' 멤버 대화로 이동했습니다.`);
                  }}
                />
              )}
              {currentView === "settings" && (
                <SettingsView
                  automationApi={state.automationApi}
                  logs={state.logs}
                  router={state.router.baseUrl}
                  settings={state.settings}
                  onToggleDebug={toggleDebug}
                  onSaveFonts={saveFonts}
                  onSaveLocale={saveLocale}
                  onSaveExecutablePaths={saveExecutablePaths}
                  cwdPrefs={cwdPrefs}
                  cwdDefaultUsage={cwdDefaultUsage}
                  memberLocations={memberLocations}
                  now={nowTick}
                  onPickDefaultCwd={(env) => void pickDefaultCwd(env)}
                  onClearDefaultCwd={(env) => void window.agentParty.clearDefaultCwd(env).then(applyCwdPreferences).catch(noticeOnFailure("기본 cwd를 지우지 못했습니다"))}
                  onPromoteRecentCwd={(entry) => void window.agentParty.setDefaultCwd(entry.location).then(applyCwdPreferences).catch(noticeOnFailure("기본 cwd로 설정하지 못했습니다"))}
                  onRemoveRecentCwd={(entry) => void window.agentParty.removeRecentCwd(entry.location).then(applyCwdPreferences).catch(noticeOnFailure("최근 목록에서 제거하지 못했습니다"))}
                  onRecheckRecentCwd={() => void refreshCwdPreferences(true)}
                  onCloneMember={(row) => { setCurrentView("workbench"); reportNotice(`${row.member} 의 설정으로 새 멤버를 만들려면 멤버 만들기에서 ${row.location.cwd} 를 고르세요.`); }}
                  tabRequest={settingsTabRequest}
                />
              )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* Opens even when the status fetch has not landed (or failed): the dialog
          can re-check from inside, and a button that does nothing would be the
          silent no-op this project forbids. */}
      {guideOfferOpen && (
        <GuideOfferDialog
          onAccept={() => {
            setGuideOfferOpen(false);
            void openGuide();
          }}
          onDismiss={() => setGuideOfferOpen(false)}
        />
      )}

      {updateModalOpen && (
        <UpdateModal
          status={updateStatus || { state: "idle", channel: "stable", currentVersion: "" }}
          onCheck={async () => { const res = await window.agentParty.checkForUpdate(); setUpdateStatus(res.update); }}
          onDownload={async () => { const res = await window.agentParty.downloadUpdate(); setUpdateStatus(res.update); }}
          onInstall={async () => { await window.agentParty.installUpdate(); }}
          onClose={() => setUpdateModalOpen(false)}
        />
      )}

      {partyNotice && (
        <div className="app-toast" role="status">
          <span>{partyNotice}</span>
          <button type="button" className="app-toast-x" title={t("shell.close")} onClick={() => setPartyNotice("")}><X size={13} /></button>
        </div>
      )}
    </div>
    </I18nProvider>
  );
}

