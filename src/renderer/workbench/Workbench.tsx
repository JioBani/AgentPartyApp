import { Fragment, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import type { DefaultMemberProfile, HarnessDefaults, PartyDefinition } from "../../shared/types";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import { RouteLike } from "./routes";
import { memberColor, memberColorVars } from "../theme/memberColors";
import { statusLabel } from "./memberStatus";
import { usePublishPartyMembers } from "../app/partyMemberPrefs";
import { usePublishModelRoutes } from "../app/modelRoutePrefs";
import {
  LayoutState,
  closeTab,
  emptyLayout,
  focusPanel,
  layoutFromPanels,
  moveTab,
  moveTabToNewPanel,
  openMember,
  openMemberInNewPanel,
  panelOf,
  promoteTab,
  pruneLayout,
  resizeAt,
  setActiveTab,
} from "./layout";
import { sanitizeLayout, type WorkbenchLayout } from "../../shared/workbenchLayout";
import { Panel } from "./Panel";
import { CreateMemberInput, CreatePartyInput, PartySidebar } from "./PartySidebar";
import type { WslBrowsing } from "./CwdPicker";
import type { PartyGroup, PartySummary, RegisteredParty } from "../../shared/partyGroups";
import type { CwdPreferences, ExecutionEnv, MemberExecutionLocation } from "../../shared/memberLocation";
import { parseMemberLocation } from "../../shared/memberLocation";
import { DEFAULT_PARTY_GROUP_ID } from "../../shared/partyGroups";
import { RuntimeModal } from "./RuntimeModal";
import { McpModal } from "./McpModal";
import { MessageGateModal } from "./MessageGateModal";
import { PartyGateModal } from "./PartyGateModal";
import type { GateReviewer, PartyGate } from "../../shared/messageGate";
import { CompactModal } from "./AutoCompactEditor";
import { PermissionModal } from "./PermissionModal";
import { SessionStatusModal } from "./SessionStatusModal";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface WorkbenchProps {
  parties: PartyDefinition[];
  activePartyId?: string;
  /**
   * The party's tab layout as the main process holds it — on load, on a party
   * switch, and whenever ANOTHER window on this party changes it. Carries its
   * own `partyId` so a late reply for the previous party is ignored rather than
   * applied to the current one. `layout: undefined` means nothing is stored yet.
   */
  partyLayout?: { partyId: string; layout?: WorkbenchLayout };
  /** Hands a layout this window produced back to the main process (the writer). */
  onPersistLayout: (layout: WorkbenchLayout) => void;
  views: MemberView[];
  routes: RouteLike[];
  /** Live Codex catalog discovery state, surfaced by the member wizard. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  defaultProfile: DefaultMemberProfile;
  /** Per-harness creation defaults, so the wizard seeds each harness's default. */
  harnessDefaults: Record<string, HarnessDefaults>;
  /** Settings reviewer default (model + effort) for the Message Gate. */
  gateDefaults: GateReviewer;
  debugEnabled: boolean;
  drawers: SidebarDrawerSettings;
  /** QA-driven panel arrangement; applied whenever `nonce` changes. */
  layoutRequest?: { panels: string[][]; nonce: number } | null;
  /** QA-driven "open this subagent's detail"; applied whenever `nonce` changes. */
  subagentOpenRequest?: { member: string; subId: string; nonce: number } | null;
  /** QA-driven "open a Message Gate modal" (member editor / party manager); applied on `nonce` change. */
  gateOpenRequest?: { kind: "member" | "party"; member: string; nonce: number } | null;
  actions: WorkbenchActions;
  onCreateParty: (input: CreatePartyInput) => Promise<boolean>;
  onCreateGroup: (name: string) => void;
  onMovePartyToGroup: (partyId: string, groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onRemoveGroup: (groupId: string) => void;
  onReorderGroups: (order: string[]) => void;
  /** Opens the platform folder picker; resolves null when the user cancelled. */
  onBrowseCwd: (env: ExecutionEnv, distro?: string) => Promise<MemberExecutionLocation | null>;
  wsl?: WslBrowsing;
  /** App-global party groups, in display order. */
  groups: PartyGroup[];
  /** Every party the app knows, from the global registry (not just this workspace). */
  registeredParties: RegisteredParty[];
  cwdPrefs: CwdPreferences;
  /** Last-resort cwd suggestion (the app's own workspace folder). */
  appWorkspaceRoot: string;
  /** Frozen "now" for recency labels, so previews render deterministically. */
  now: number;
  onCreateMember: (input: CreateMemberInput) => Promise<boolean>;
  onRemoveMember: (member: string) => void;
  /** Idle-sleep controls for one member (pin awake, sleep now, wake now). */
  onSetMemberKeepAwake: (member: string, keepAwake: boolean) => void;
  onSleepMember: (member: string) => void;
  onWakeMember: (member: string) => void;
  onRemoveParty: (partyId: string) => void;
  /** Opens a party in another window of this process (shared engine + sessions). */
  onOpenPartyInNewWindow: (partyId: string) => void;
  onSelectParty: (partyId: string) => void;
  onMemberOpened: (member: string) => void;
  /** Members frontmost in a panel — what the user is actually looking at. */
  onVisibleMembersChange: (partyId: string, members: string[]) => void;
  onToggleDrawer: (which: SidebarDrawerId, patch: Partial<SidebarDrawerState>) => void;
  /** App-shell views opened by AgentParty-backed slash commands. */
  onOpenUsage: () => void;
}

interface DragState {
  member: string;
  x: number;
  y: number;
  overPanelId?: string;
  overTab?: string;
  /** Drop lands after `overTab` rather than before it (cursor past its middle). */
  overAfter?: boolean;
  overNew: boolean;
}

const DRAG_THRESHOLD = 5;
const SUBUI_KEY = "agentparty.subagentUi";
/**
 * Delays between prewarm attempts for an open tab that still has no session.
 * Widens to stay cheap, then holds at the last value so a workspace engine that
 * only recovers minutes later still revives the tab instead of leaving it dead.
 */
const PREWARM_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Per-member subagent UI state (which detail is open + dock collapsed). */
interface SubagentUiState {
  open: Record<string, string>;
  collapsed: Record<string, boolean>;
}

function loadSubagentUi(): SubagentUiState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SUBUI_KEY) || "{}");
    return { open: parsed.open || {}, collapsed: parsed.collapsed || {} };
  } catch {
    return { open: {}, collapsed: {} };
  }
}

export function Workbench(props: WorkbenchProps) {
  const { parties, activePartyId, partyLayout, onPersistLayout, views, routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, gateDefaults, debugEnabled, drawers, layoutRequest, subagentOpenRequest, gateOpenRequest, actions, onCreateParty, onCreateGroup, onMovePartyToGroup, onRenameGroup, onRemoveGroup, onReorderGroups, onBrowseCwd, wsl, groups, registeredParties, cwdPrefs, appWorkspaceRoot, now, onCreateMember, onRemoveMember, onSetMemberKeepAwake, onSleepMember, onWakeMember, onRemoveParty, onOpenPartyInNewWindow, onSelectParty, onMemberOpened, onVisibleMembersChange, onToggleDrawer, onOpenUsage } = props;

  const viewMap = useMemo(() => new Map(views.map((view) => [view.name, view])), [views]);
  const validMembers = useMemo(() => new Set(views.map((view) => view.name)), [views]);
  const partyKey = activePartyId || "default";

  // `:m` completion offers these and only these. Published from the same `views`
  // the workbench already renders, so the popover cannot name a member the party
  // does not have — a mention of nobody would simply go nowhere.
  usePublishPartyMembers(useMemo(
    () => views.map((view) => ({ name: view.name, color: view.color, status: statusLabel(view.status) })),
    [views],
  ));
  // Same arrangement for `:a`: the composer completes models from the routes the
  // rest of the workbench already picks from, so the text it writes can only
  // name a model the app actually knows how to run.
  usePublishModelRoutes(routes);

  const [layout, setLayout] = useState<LayoutState>(emptyLayout);
  /**
   * The party whose MEMBER LIST has actually loaded when we seeded the layout.
   * Workbench can mount before the party state arrives (views=[]); seeding,
   * pruning, or saving in that window destroys the stored layout — the
   * "my tabs closed by themselves after relaunch" bug. Until this matches
   * partyKey, the layout is provisional: never pruned against an empty member
   * list and never persisted.
   */
  const seededPartyRef = useRef<string | null>(null);
  /**
   * The last layout this window agreed on with the main process, serialized.
   *
   * Guards both directions of the sync. A layout that ARRIVED from main must not
   * be pushed straight back, and a layout this window produced must not be
   * re-adopted as if it were news — either way the two would trade updates
   * while the user is still dragging.
   */
  const syncedLayoutRef = useRef<string>("");
  const [runtimeTarget, setRuntimeTarget] = useState<string | null>(null);
  const [permissionTarget, setPermissionTarget] = useState<string | null>(null);
  const [mcpTarget, setMcpTarget] = useState<string | null>(null);
  const [statusTarget, setStatusTarget] = useState<string | null>(null);
  const [gateTarget, setGateTarget] = useState<string | null>(null);
  const [partyGateTarget, setPartyGateTarget] = useState<string | null>(null);
  const [compactTarget, setCompactTarget] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [subUi, setSubUi] = useState<SubagentUiState>(loadSubagentUi);

  const workAreaRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ member: string; x: number; y: number; active: boolean } | null>(null);
  const resizeRef = useRef<{ snapshot: LayoutState; leftId: string; rightId: string; startX: number; pairPx: number } | null>(null);
  // Tracks members already seen for the current party, so only members created
  // *after* the party is showing auto-open (initial load / party-switch don't).
  const knownMembersRef = useRef<{ partyKey: string; names: Set<string> }>({ partyKey: "", names: new Set() });


  useEffect(() => {
    try {
      window.localStorage.setItem(SUBUI_KEY, JSON.stringify(subUi));
    } catch {
      // Best-effort.
    }
  }, [subUi]);

  // Subagent dock/detail UI handlers, addressed by member name.
  function toggleSubDock(member: string) {
    setSubUi((current) => ({ ...current, collapsed: { ...current.collapsed, [member]: !current.collapsed[member] } }));
  }
  function openSub(member: string, id: string) {
    setSubUi((current) => ({ ...current, open: { ...current.open, [member]: id } }));
  }
  function closeSub(member: string) {
    setSubUi((current) => {
      const open = { ...current.open };
      delete open[member];
      return { ...current, open };
    });
  }

  // Apply a QA-driven "open subagent detail" request (mock-driven detail QA).
  // `subId: "first"` opens the member's first subagent (convenient when the id is
  // harness-assigned and not known to the caller).
  useEffect(() => {
    if (subagentOpenRequest) {
      const { member, subId } = subagentOpenRequest;
      const resolved = subId === "first" ? viewMap.get(member)?.subagents[0]?.id : subId;
      if (resolved) {
        openSub(member, resolved);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentOpenRequest?.nonce]);

  // QA: open a Message Gate modal (member editor / party manager) over HTTP so an
  // agent can drive the real UI route + screenshot it. See docs/E2E_TESTING.md.
  useEffect(() => {
    if (!gateOpenRequest) {
      return;
    }
    if (gateOpenRequest.kind === "party") {
      setPartyGateTarget(gateOpenRequest.member || activePartyId || null);
    } else if (gateOpenRequest.member) {
      setGateTarget(gateOpenRequest.member);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateOpenRequest?.nonce]);

  // Prewarm retry cadence — see the effect below. Keyed by party + the set of
  // sessionless tabs so the backoff restarts whenever that set changes.
  const prewarmRetryRef = useRef<{ key: string; attempt: number }>({ key: "", attempt: 0 });
  const [prewarmTick, setPrewarmTick] = useState(0);

  // Adopt the party's authoritative layout: the main process's copy on load or a
  // party switch, and every later change made in ANOTHER window on this party.
  //
  // Waits for the member list too — seeding or pruning against a not-yet-loaded
  // (empty) list is the "my tabs closed by themselves" bug.
  const membersLoaded = views.length > 0;
  useEffect(() => {
    if (!membersLoaded || !partyLayout || partyLayout.partyId !== partyKey) {
      return;
    }
    const serialized = layoutFingerprint(partyLayout.layout);
    if (seededPartyRef.current === partyKey && serialized === syncedLayoutRef.current) {
      return;
    }
    seededPartyRef.current = partyKey;
    syncedLayoutRef.current = serialized;
    setLayout(seedLayout(partyLayout.layout, views));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyKey, membersLoaded, partyLayout]);

  // Drop tabs for members that no longer exist; persist after every change.
  // Skipped until the member list has loaded — pruning against a not-yet-loaded
  // (empty) list would silently close every restored tab.
  useEffect(() => {
    if (validMembers.size === 0) {
      return;
    }
    setLayout((current) => {
      const pruned = pruneLayout(current, validMembers);
      return sameLayout(pruned, current) ? current : pruned;
    });
  }, [validMembers]);

  // Auto-open members created while this party is showing, each in its OWN new
  // panel (a fresh region) so it goes live immediately instead of to background.
  // A party switch / first mount only seeds the baseline — it does not auto-open.
  useEffect(() => {
    // Wait for the member list to load: seeding the tracker with an empty
    // pre-load list made every existing member look "just created" a moment
    // later, auto-opening ALL tabs on relaunch.
    if (views.length === 0) {
      return;
    }
    const currentNames = new Set(views.map((view) => view.name));
    const tracker = knownMembersRef.current;
    if (tracker.partyKey !== partyKey) {
      knownMembersRef.current = { partyKey, names: currentNames };
      return;
    }
    const added = [...currentNames].filter((name) => !tracker.names.has(name));
    knownMembersRef.current = { partyKey, names: currentNames };
    if (added.length === 0) {
      return;
    }
    setLayout((current) => added.reduce((state, name) => (panelOf(state, name) ? state : openMemberInNewPanel(state, name)), current));
    added.forEach((name) => onMemberOpened(name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, partyKey]);

  useEffect(() => {
    // Persist only a layout seeded from a LOADED party; a provisional
    // (pre-load) layout would overwrite the user's stored tabs with nothing.
    // And only what this window actually changed — pushing back a layout that
    // just arrived from another window would bounce it around forever.
    if (seededPartyRef.current === partyKey) {
      const serialized = layoutFingerprint(layout);
      if (serialized !== syncedLayoutRef.current) {
        syncedLayoutRef.current = serialized;
        onPersistLayout(layout);
      }
    }
    const focused = layout.panels.find((panel) => panel.id === layout.focusedPanelId);
    const visibleInRestoreOrder = [
      ...(focused ? [focused] : []),
      ...layout.panels.filter((panel) => panel !== focused),
    ].map((panel) => panel.active).filter(Boolean);
    onVisibleMembersChange(partyKey, visibleInRestoreOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, partyKey]);

  // Revive EVERY open tab's session, not only each panel's active tab. After a
  // relaunch the party store still carries the previous process's dead
  // sessionId, so a restored background tab used to sit "open but closed":
  // other members' member-status saw missing_session and the MCP menu stayed
  // empty until a manual 세션 재시작. An open tab is an explicit "keep this
  // member live" — prewarm any that lack a live session. ensureSession dedupes
  // in-flight starts, and prewarm skips members the user explicitly closed.
  // Only members bound to NOTHING are prewarmed.
  //
  // Two exclusions, both for members that are sessionless BY DESIGN and would
  // otherwise keep the retry cadence below ticking forever:
  //
  //  - `sleeping`: the app just released that process to reclaim memory.
  //  - a member that still carries a `sessionId` we cannot see: it is running
  //    under a sibling app process on this workspace. The engine refuses to
  //    start a second harness for it, so retrying only burns round trips. A
  //    binding whose owner is actually gone is cleared on the next state read
  //    (reconcileStaleSessionBindings), and the member becomes prewarmable then
  //    — which is what makes an ordinary relaunch still revive its tabs.
  const sessionlessOpenTabs = useMemo(
    () => layout.panels
      .flatMap((panel) => panel.tabs)
      .filter((name) => {
        const view = viewMap.get(name);
        if (!view || view.session || view.status === "sleeping" || view.status === "external-cli") {
          return false;
        }
        // `missing_session` is the app's own statement that the binding is dead,
        // so that member DOES need starting; any other bound member is running
        // under a sibling process and the engine will refuse to clone it.
        return !view.member.sessionId || view.member.status === "missing_session";
      })
      .sort()
      .join("|"),
    [layout, viewMap],
  );
  useEffect(() => {
    if (!membersLoaded || seededPartyRef.current !== partyKey || !sessionlessOpenTabs) {
      return;
    }
    for (const name of sessionlessOpenTabs.split("|")) {
      actions.prewarm(name);
    }
    // One attempt was not enough. A start rejects while the workspace engine is
    // still connecting — the common case right after a relaunch, and the reason
    // a restored WSL tab could sit open with no session until a manual 세션
    // 재시작. Nothing else re-runs this effect: its inputs do not change while a
    // tab stays sessionless. So schedule a re-check; each pass reads fresh
    // member/session state instead of a closure captured minutes ago.
    //
    // The delay widens and then holds, so recovery stays cheap but never gives
    // up: an engine that comes back later still heals the tab. The loop ends by
    // itself once every open tab has a session, because `sessionlessOpenTabs`
    // goes empty and the guard above returns.
    const key = `${partyKey}|${sessionlessOpenTabs}`;
    if (prewarmRetryRef.current.key !== key) {
      prewarmRetryRef.current = { key, attempt: 0 };
    }
    const wait = PREWARM_RETRY_MS[Math.min(prewarmRetryRef.current.attempt, PREWARM_RETRY_MS.length - 1)];
    const timer = window.setTimeout(() => {
      prewarmRetryRef.current.attempt += 1;
      setPrewarmTick((tick) => tick + 1);
    }, wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionlessOpenTabs, membersLoaded, partyKey, prewarmTick]);

  // Apply a QA-driven panel arrangement when requested.
  useEffect(() => {
    if (!layoutRequest) {
      return;
    }
    const valid = layoutRequest.panels
      .map((tabs) => tabs.filter((name) => validMembers.has(name)))
      .filter((tabs) => tabs.length > 0);
    if (valid.length > 0) {
      setLayout(layoutFromPanels(valid));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutRequest?.nonce]);

  function handleOpenMember(member: string) {
    setLayout((current) => openMember(current, member));
    onMemberOpened(member);
  }

  function handleCreateMember(input: CreateMemberInput) {
    // The new member is opened in its own panel by the new-member effect below,
    // once it arrives via the party broadcast (uniform for wizard + agent creates).
    return onCreateMember(input);
  }

  // --- Tab drag-and-drop --------------------------------------------------
  function onTabPointerDown(member: string, event: ReactPointerEvent) {
    if (event.button !== 0) {
      return;
    }
    dragStart.current = { member, x: event.clientX, y: event.clientY, active: false };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function onPointerMove(event: PointerEvent) {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    if (!start.active) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) {
        return;
      }
      start.active = true;
    }
    const hit = hitTest(event.clientX, event.clientY);
    setDrag({ member: start.member, x: event.clientX, y: event.clientY, overPanelId: hit.panelId, overTab: hit.tab, overAfter: hit.after, overNew: hit.newPanel });
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    const start = dragStart.current;
    dragStart.current = null;
    if (!start || !start.active) {
      setDrag(null);
      return;
    }
    setDrag((current) => {
      if (current) {
        const { member, overPanelId, overTab, overAfter, overNew } = current;
        if (overNew) {
          setLayout((state) => moveTabToNewPanel(state, member, overPanelId));
        } else if (overPanelId) {
          setLayout((state) => moveTab(state, member, overPanelId, overTab, overAfter));
        }
      }
      return null;
    });
  }

  function hitTest(x: number, y: number): { panelId?: string; tab?: string; after: boolean; newPanel: boolean } {
    const stack = document.elementsFromPoint(x, y);
    let panelId: string | undefined;
    let tab: string | undefined;
    // Which side of the hovered tab the drop lands on. Taken from the cursor
    // against the tab's own midpoint, so pushing a tab rightwards past its
    // neighbour actually moves it past that neighbour.
    let after = false;
    let newPanel = false;
    for (const element of stack) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      if (!newPanel && element.dataset.dropNewpanel) {
        newPanel = true;
      }
      if (!tab && element.dataset.dropTab) {
        tab = element.dataset.dropTab;
        const rect = element.getBoundingClientRect();
        after = x > rect.left + rect.width / 2;
      }
      if (!panelId && element.dataset.panelId) {
        panelId = element.dataset.panelId;
      }
    }
    return { panelId, tab, after, newPanel };
  }

  // --- Panel resize -------------------------------------------------------
  function onResizeDown(leftId: string, rightId: string, event: ReactPointerEvent) {
    const area = workAreaRef.current;
    const leftEl = area?.querySelector<HTMLElement>(`[data-panel-id="${leftId}"]`);
    const rightEl = area?.querySelector<HTMLElement>(`[data-panel-id="${rightId}"]`);
    if (!leftEl || !rightEl) {
      return;
    }
    resizeRef.current = {
      snapshot: layout,
      leftId,
      rightId,
      startX: event.clientX,
      pairPx: leftEl.getBoundingClientRect().width + rightEl.getBoundingClientRect().width,
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp, { once: true });
    document.body.classList.add("wb-resizing");
  }

  function onResizeMove(event: PointerEvent) {
    const ref = resizeRef.current;
    if (!ref) {
      return;
    }
    const deltaRatio = (event.clientX - ref.startX) / Math.max(1, ref.pairPx);
    setLayout(resizeAt(ref.snapshot, ref.leftId, ref.rightId, deltaRatio));
  }

  function onResizeUp() {
    window.removeEventListener("pointermove", onResizeMove);
    resizeRef.current = null;
    document.body.classList.remove("wb-resizing");
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointermove", onResizeMove);
      document.body.classList.remove("wb-resizing");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openMembers = useMemo(() => new Set(layout.panels.flatMap((panel) => panel.tabs)), [layout]);
  const runtimeView = runtimeTarget ? viewMap.get(runtimeTarget) : undefined;
  const permissionView = permissionTarget ? viewMap.get(permissionTarget) : undefined;
  const mcpView = mcpTarget ? viewMap.get(mcpTarget) : undefined;
  const statusView = statusTarget ? viewMap.get(statusTarget) : undefined;
  const compactView = compactTarget ? viewMap.get(compactTarget) : undefined;
  const gateView = gateTarget ? viewMap.get(gateTarget) : undefined;
  const activeParty = parties.find((party) => party.id === activePartyId);
  const gateParty = partyGateTarget ? parties.find((party) => party.id === partyGateTarget) : undefined;

  const { workingByParty, memberCountByParty } = useMemo(() => aggregateByParty(views, parties), [views, parties]);
  /**
   * The list's own view of the parties.
   *
   * Counts come from the LOADED party's member views, so an unselected party
   * reports 0 rather than a number nobody measured — the summary store that
   * answers for all of them lands with the group backend. Showing a fabricated
   * count would be worse than showing none.
   */
  /**
   * The list the sidebar draws: the app-global registry, with THIS window's live
   * numbers laid over the party it actually has open.
   *
   * The registry is the only source that knows a party this window never
   * opened — including ones in other workspaces, which is what makes the list
   * independent of where the app was launched. The overlay exists because the
   * registry is refreshed on party changes, not on every turn: "running 2" has
   * to move the moment a member starts working, and only this window sees that.
   */
  const partySummaries = useMemo<PartySummary[]>(() => {
    const live = new Map(parties.map((party) => [party.id, party] as const));
    const merged: PartySummary[] = registeredParties.map((entry) => {
      const loaded = entry.id === activePartyId;
      const members = loaded ? views : [];
      return {
        ...entry,
        name: live.get(entry.id)?.name ?? entry.name,
        memberCount: loaded ? memberCountByParty[entry.id] || 0 : entry.memberCount,
        runningCount: loaded ? workingByParty[entry.id] || 0 : entry.runningCount,
        windowsCount: loaded ? members.filter((view) => envOfMember(view) === "windows").length : entry.windowsCount,
        wslCount: loaded ? members.filter((view) => envOfMember(view) === "wsl").length : entry.wslCount,
      };
    });
    // A party this workspace has but the registry has not caught up with yet
    // (the refresh is a round trip) still belongs in the list.
    const known = new Set(merged.map((entry) => entry.id));
    for (const party of parties) {
      if (!known.has(party.id)) {
        merged.push({
          id: party.id,
          groupId: party.groupId ?? DEFAULT_PARTY_GROUP_ID,
          name: party.name,
          memberCount: party.id === activePartyId ? memberCountByParty[party.id] || 0 : undefined,
          runningCount: workingByParty[party.id] || 0,
          windowsCount: 0,
          wslCount: 0,
          updatedAt: party.updatedAt,
        });
      }
    }
    return merged;
  }, [registeredParties, parties, views, activePartyId, workingByParty, memberCountByParty]);

  return (
    <div
      className="wb-root"
      data-party-id={partyKey}
      data-layout-party={seededPartyRef.current === partyKey ? partyKey : ""}
    >
      <PartySidebar
        activePartyId={activePartyId}
        views={views}
        openMembers={openMembers}
        drawers={drawers}
        onToggleDrawer={onToggleDrawer}
        routes={routes}
        codexModels={codexModels}
        onRefreshCodexModels={onRefreshCodexModels}
        defaultProfile={defaultProfile}
        harnessDefaults={harnessDefaults}
        groups={groups}
        partySummaries={partySummaries}
        cwdPrefs={cwdPrefs}
        appWorkspaceRoot={appWorkspaceRoot}
        now={now}
        onSelectParty={onSelectParty}
        onCreateParty={onCreateParty}
        onCreateGroup={onCreateGroup}
        onMovePartyToGroup={onMovePartyToGroup}
        onRenameGroup={onRenameGroup}
        onRemoveGroup={onRemoveGroup}
        onReorderGroups={onReorderGroups}
        onBrowseCwd={onBrowseCwd}
        wsl={wsl}
        onCreateMember={handleCreateMember}
        onOpenMember={handleOpenMember}
        onRestartMember={(member) => actions.restart(member)}
        onRemoveMember={onRemoveMember}
        onSetMemberKeepAwake={onSetMemberKeepAwake}
        onSleepMember={onSleepMember}
        onWakeMember={onWakeMember}
        onRemoveParty={onRemoveParty}
        onOpenPartyGate={setPartyGateTarget}
        onOpenPartyInNewWindow={onOpenPartyInNewWindow}
      />

      <div className={"wb-workarea" + (drag ? " is-dragging" : "")} ref={workAreaRef}>
        {layout.panels.length === 0 && (
          <div className="wb-workarea-empty">
            <p><LocalizedText id="STR-2291" /></p>
          </div>
        )}
        {layout.panels.map((panel, index) => (
          <Fragment key={panel.id}>
            {index > 0 && (
              <div
                className="wb-resize-handle"
                onPointerDown={(event) => onResizeDown(layout.panels[index - 1].id, panel.id, event)}
              />
            )}
            <Panel
              panel={panel}
              views={viewMap}
              focused={panel.id === layout.focusedPanelId}
              draggingMember={drag?.member ?? null}
              dropTarget={Boolean(drag && !drag.overNew && drag.overPanelId === panel.id)}
              dropAt={drag && !drag.overNew && drag.overPanelId === panel.id && drag.overTab
                ? { tab: drag.overTab, after: Boolean(drag.overAfter) }
                : null}
              actions={actions}
              onFocus={() => setLayout((current) => focusPanel(current, panel.id))}
              onSelectTab={(member) => setLayout((current) => setActiveTab(current, panel.id, member))}
              onCloseTab={(member) => {
                // Closing the tab also closes the member's session (frees its
                // context + provider usage); it stays reopenable via the sidebar.
                actions.closeSession(member);
                setLayout((current) => closeTab(current, panel.id, member));
              }}
              onPromoteTab={(member) => setLayout((current) => promoteTab(current, panel.id, member))}
              onOpenRuntime={setRuntimeTarget}
              onOpenPermissions={setPermissionTarget}
              onOpenMcp={setMcpTarget}
              onOpenStatus={setStatusTarget}
              onOpenCompact={setCompactTarget}
              onOpenUsage={onOpenUsage}
              onOpenGate={setGateTarget}
              onTabPointerDown={onTabPointerDown}
              openSubId={subUi.open[panel.active]}
              subDockCollapsed={subUi.collapsed[panel.active]}
              onToggleSubDock={() => toggleSubDock(panel.active)}
              onOpenSub={(id) => openSub(panel.active, id)}
              onCloseSub={() => closeSub(panel.active)}
            />
          </Fragment>
        ))}
        {drag && (
          <div className={"wb-newpanel-zone" + (drag.overNew ? " is-over" : "")} data-drop-newpanel="1">
            <span><LocalizedText id="STR-2292" /></span>
          </div>
        )}
      </div>

      {drag && (
        <div className="wb-drag-ghost" style={{ left: drag.x, top: drag.y, ...memberColorVars(drag.member) }}>
          <span className="wb-dot" style={{ background: memberColor(drag.member) }} />
          {drag.member}
        </div>
      )}

      {runtimeView && (
        <RuntimeModal
          view={runtimeView}
          routes={routes}
          debugEnabled={debugEnabled}
          actions={actions}
          onClose={() => setRuntimeTarget(null)}
        />
      )}

      {permissionView && (
        <PermissionModal view={permissionView} actions={actions} onClose={() => setPermissionTarget(null)} />
      )}

      {mcpView && (
        <McpModal
          view={mcpView}
          actions={actions}
          onClose={() => setMcpTarget(null)}
        />
      )}

      {statusView && (
        <SessionStatusModal view={statusView} onClose={() => setStatusTarget(null)} />
      )}

      {compactView && (
        <CompactModal
          view={compactView}
          actions={actions}
          onClose={() => setCompactTarget(null)}
        />
      )}

      {gateView && (
        <MessageGateModal
          view={gateView}
          routes={routes}
          partyGate={activeParty?.gate}
          gateDefaults={gateDefaults}
          onApply={(patch) => actions.setMemberGate(gateView.name, patch)}
          onClose={() => setGateTarget(null)}
        />
      )}

      {gateParty && (
        <PartyGateModal
          party={gateParty}
          members={views}
          routes={routes}
          gateDefaults={gateDefaults}
          onSetPartyGate={(gate) => actions.setPartyGate(gateParty.id, gate)}
          onSetMemberGate={(name, mode) => actions.setMemberGate(name, { mode })}
          onClearMemberRule={(name) => actions.setMemberGate(name, { rule: null })}
          onOpenMemberGate={(name) => { setPartyGateTarget(null); setGateTarget(name); }}
          onClose={() => setPartyGateTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * A layout's identity for the sync guards, taken through the SAME sanitiser the
 * main process applies before storing.
 *
 * Comparing raw JSON both ways would be wrong: what comes back from main has
 * been rebuilt field by field, so an incidental difference in key order or a
 * dropped empty panel reads as "someone else changed it" and the two sides
 * exchange one pointless round trip each time.
 */
function layoutFingerprint(layout: WorkbenchLayout | undefined): string {
  return JSON.stringify(sanitizeLayout(layout) ?? null);
}

/**
 * The layout to show for a party: the stored one pruned to members that still
 * exist, or a first tab when nothing is stored.
 *
 * A stored layout with NO panels is honoured as-is — the user closed every tab,
 * and reseeding would reopen one they just closed. Only the absence of a stored
 * layout means "seed from the member list".
 */
function seedLayout(stored: WorkbenchLayout | undefined, views: MemberView[]): LayoutState {
  if (stored) {
    return pruneLayout(stored, new Set(views.map((view) => view.name)));
  }
  const first = views[0];
  if (!first) {
    return emptyLayout();
  }
  return openMember(emptyLayout(), first.name);
}

/** Which environment a member runs in, or undefined for one created before cwds. */
function envOfMember(view: MemberView): ExecutionEnv | undefined {
  const stored = view.member.location;
  return stored ? parseMemberLocation(stored).env : undefined;
}

function aggregateByParty(views: MemberView[], parties: PartyDefinition[]): { workingByParty: Record<string, number>; memberCountByParty: Record<string, number> } {
  const workingByParty: Record<string, number> = {};
  const memberCountByParty: Record<string, number> = {};
  for (const party of parties) {
    workingByParty[party.id] = 0;
    memberCountByParty[party.id] = 0;
  }
  for (const view of views) {
    const partyId = view.member.partyId || "";
    memberCountByParty[partyId] = (memberCountByParty[partyId] || 0) + 1;
    if (view.busy) {
      workingByParty[partyId] = (workingByParty[partyId] || 0) + 1;
    }
  }
  return { workingByParty, memberCountByParty };
}

function sameLayout(a: LayoutState, b: LayoutState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

import type { SidebarDrawerId, SidebarDrawerSettings, SidebarDrawerState } from "../../shared/sidebarDrawers";
