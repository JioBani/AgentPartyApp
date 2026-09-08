import { Fragment, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import type { DefaultMemberProfile, HarnessDefaults, PartyDefinition } from "../../shared/types";
import type { MemberView, PanelState } from "./types";
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
  promoteTab,
  pruneLayout,
  moveTabToOuterSlot,
  resizeSplit,
  setActiveTab,
  splitPanel,
} from "./layout";
import { sanitizeLayout, type WorkbenchLayout } from "../../shared/workbenchLayout";
import { rowGrid, type GridNode, type GridSide } from "../../shared/workbenchGrid";
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
  /**
   * The edge of `overPanelId` the cursor is in, if any: the drop splits that
   * panel and puts the member in a new slot on that side. Undefined means the
   * middle — join the panel as a tab.
   *
   * This replaced a separate "drop here for a new panel" strip at the end of the
   * work area. That strip could only ever append one more column, and it sat
   * exactly where the drop that splits the rightmost panel now has to land — so
   * aiming at a right edge produced an appended panel instead of a split.
   */
  overSide?: GridSide;
  /**
   * The cursor is against an outer edge of the whole work area: the drop gives
   * the member a slot spanning the ENTIRE grid on that side — a full-width row
   * under everything, rather than a division of one panel.
   */
  overOuter?: GridSide;
}

/** Resize in progress: which divider, and how big the pair it separates is. */
interface ResizeState {
  snapshot: LayoutState;
  splitId: string;
  index: number;
  dir: "row" | "column";
  start: number;
  pairPx: number;
  /** Size of the first of the two nodes when the drag began. */
  firstPx: number;
}

const DRAG_THRESHOLD = 5;
/**
 * How much of a panel counts as its edge for a split-drop, as a fraction of the
 * panel. Generous enough to aim at without the middle — "just put it in this
 * group" — becoming hard to hit in a narrow panel.
 */
const EDGE_ZONE = 0.24;
/**
 * Smallest a slot may be dragged to, in pixels. The layout engine already keeps
 * a minimum SHARE, but a share means nothing in a nested grid: an eighth of a
 * half is a panel too short to hold its own toolbar. This is the floor a person
 * actually cares about.
 */
const MIN_PANEL_PX = 140;
/**
 * How close to the work area's own border a drop means "span the whole grid".
 * In pixels, not a fraction: it is a border band the user pushes INTO, and it
 * has to stay reachable in a small window without eating the outermost panel's
 * own edge zones.
 */
const OUTER_EDGE_PX = 26;
const SUBUI_KEY = "agentparty.subagentUi";
const CHROME_KEY = "agentparty.panelChrome";
/**
 * Delays between prewarm attempts for an open tab that still has no session.
 * Widens to stay cheap, then holds at the last value so a workspace engine that
 * only recovers minutes later still revives the tab instead of leaving it dead.
 */
const PREWARM_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Which of a member's panel bars are folded away, by member name.
 *
 * Per MEMBER, like the subagent dock beside it, and kept in this window's
 * storage rather than in the party layout: it is how one person is reading
 * right now, not part of the arrangement every window on the party shares.
 */
type PanelChromeState = Record<string, { toolbar?: boolean; composer?: boolean }>;


function loadPanelChrome(): PanelChromeState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHROME_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Per-member subagent UI state (which detail is open + dock collapsed). */
interface SubagentUiState {
  open: Record<string, string>;
  collapsed: Record<string, boolean>;
}

/**
 * Which edge zone of a panel a point is in, or undefined for its middle.
 *
 * The nearest edge wins, so the corners resolve to whichever side the cursor is
 * actually closer to instead of to a fixed axis — dragging into the bottom-left
 * corner of a panel splits it the way it looks like it will.
 */
function edgeSide(rect: DOMRect, x: number, y: number): GridSide | undefined {
  if (rect.width <= 0 || rect.height <= 0) {
    return undefined;
  }
  const distances: Array<{ side: GridSide; ratio: number }> = [
    { side: "left", ratio: (x - rect.left) / rect.width },
    { side: "right", ratio: (rect.right - x) / rect.width },
    { side: "top", ratio: (y - rect.top) / rect.height },
    { side: "bottom", ratio: (rect.bottom - y) / rect.height },
  ];
  const nearest = distances.reduce((best, item) => (item.ratio < best.ratio ? item : best));
  return nearest.ratio <= EDGE_ZONE ? nearest.side : undefined;
}

/**
 * Which outer edge of the work area a point is pressed against, if any.
 *
 * A band rather than a fraction, and inclusive of the area's padding, so the
 * gesture is "push the tab to the window's edge" — reachable at any window size.
 */
function outerSide(area: DOMRect, x: number, y: number): GridSide | undefined {
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
    return undefined;
  }
  const distances: Array<{ side: GridSide; px: number }> = [
    { side: "left", px: x - area.left },
    { side: "right", px: area.right - x },
    { side: "top", px: y - area.top },
    { side: "bottom", px: area.bottom - y },
  ];
  const nearest = distances.reduce((best, item) => (item.px < best.px ? item : best));
  return nearest.px <= OUTER_EDGE_PX ? nearest.side : undefined;
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

  // Member completion offers these and only these. Published from the same `views`
  // the workbench already renders, so the popover cannot name a member the party
  // does not have — a mention of nobody would simply go nowhere.
  usePublishPartyMembers(useMemo(
    () => views.map((view) => ({ name: view.name, color: view.color, status: statusLabel(view.status) })),
    [views],
  ));
  // Same arrangement for models: the composer completes from the routes the
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
  /**
   * Fingerprint currently being adopted from main.
   *
   * React runs every effect from the current render before committing the state
   * update scheduled by an earlier effect. Without this guard, the persistence
   * effect below sees the OLD local layout in that gap and writes it over the
   * authoritative incoming layout — most visible when member creation places a
   * tab and broadcasts it immediately.
   */
  const adoptingLayoutRef = useRef<string | null>(null);
  const [runtimeTarget, setRuntimeTarget] = useState<string | null>(null);
  const [permissionTarget, setPermissionTarget] = useState<string | null>(null);
  const [mcpTarget, setMcpTarget] = useState<string | null>(null);
  const [statusTarget, setStatusTarget] = useState<string | null>(null);
  const [gateTarget, setGateTarget] = useState<string | null>(null);
  const [partyGateTarget, setPartyGateTarget] = useState<string | null>(null);
  const [compactTarget, setCompactTarget] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [subUi, setSubUi] = useState<SubagentUiState>(loadSubagentUi);
  const [panelChrome, setPanelChrome] = useState<PanelChromeState>(loadPanelChrome);

  const workAreaRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ member: string; x: number; y: number; active: boolean } | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  useEffect(() => {
    try {
      window.localStorage.setItem(SUBUI_KEY, JSON.stringify(subUi));
    } catch {
      // Best-effort.
    }
  }, [subUi]);
  useEffect(() => {
    try {
      window.localStorage.setItem(CHROME_KEY, JSON.stringify(panelChrome));
    } catch {
      // Best-effort.
    }
  }, [panelChrome]);

  function toggleChrome(member: string, which: "toolbar" | "composer") {
    setPanelChrome((current) => ({
      ...current,
      [member]: { ...current[member], [which]: !current[member]?.[which] },
    }));
  }

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
    adoptingLayoutRef.current = serialized;
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

  useEffect(() => {
    // Persist only a layout seeded from a LOADED party; a provisional
    // (pre-load) layout would overwrite the user's stored tabs with nothing.
    // And only what this window actually changed — pushing back a layout that
    // just arrived from another window would bounce it around forever.
    if (seededPartyRef.current === partyKey) {
      const serialized = layoutFingerprint(layout);
      const adopting = adoptingLayoutRef.current;
      if (adopting && serialized === adopting) {
        // The authoritative state update has now committed; normal local
        // persistence can resume on the next user change.
        adoptingLayoutRef.current = null;
      } else if (!adopting && serialized !== syncedLayoutRef.current) {
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
    // Placement is part of the backend creation mutation, so UI, HTTP, MCP and
    // every window receive the same authoritative layout.
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
    setDrag({
      member: start.member,
      x: event.clientX,
      y: event.clientY,
      overPanelId: hit.panelId,
      overTab: hit.tab,
      overAfter: hit.after,
      overSide: hit.side,
      overOuter: hit.outer,
    });
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
        const { member, overPanelId, overTab, overAfter, overSide, overOuter } = current;
        if (overOuter) {
          setLayout((state) => moveTabToOuterSlot(state, member, overOuter));
        } else if (overPanelId && overSide) {
          setLayout((state) => moveTabToNewPanel(state, member, overPanelId, overSide));
        } else if (overPanelId) {
          setLayout((state) => moveTab(state, member, overPanelId, overTab, overAfter));
        }
      }
      return null;
    });
  }

  function hitTest(x: number, y: number): { panelId?: string; tab?: string; after: boolean; side?: GridSide; outer?: GridSide } {
    const stack = document.elementsFromPoint(x, y);
    let panelId: string | undefined;
    let panelRect: DOMRect | undefined;
    let tab: string | undefined;
    // Which side of the hovered tab the drop lands on. Taken from the cursor
    // against the tab's own midpoint, so pushing a tab rightwards past its
    // neighbour actually moves it past that neighbour.
    let after = false;
    let overStrip = false;
    for (const element of stack) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      if (!overStrip && element.classList.contains("wb-tabstrip")) {
        overStrip = true;
      }
      if (!tab && element.dataset.dropTab) {
        tab = element.dataset.dropTab;
        const rect = element.getBoundingClientRect();
        after = x > rect.left + rect.width / 2;
      }
      if (!panelId && element.dataset.panelId) {
        panelId = element.dataset.panelId;
        panelRect = element.getBoundingClientRect();
      }
    }
    // The tab strip is where ordering is expressed, so a drop there always means
    // "join this group at this position" — never a split, however close to an
    // edge the cursor happens to be.
    // The outer band wins over a panel's own edge: the two overlap along the
    // outermost panels, and the whole-grid split is the one that cannot be
    // expressed any other way.
    const area = workAreaRef.current?.getBoundingClientRect();
    const outer = area && !overStrip ? outerSide(area, x, y) : undefined;
    const side = !outer && panelRect && !overStrip ? edgeSide(panelRect, x, y) : undefined;
    return { panelId, tab, after, side, outer };
  }

  // --- Panel resize -------------------------------------------------------
  //
  // A divider belongs to ONE split and separates the pair around `index` in it,
  // so a drag never reaches past its own two neighbours — that is what keeps
  // resizing a nested column from disturbing the rest of the grid. The pair is
  // measured from the handle's own DOM siblings, which are exactly those two
  // nodes whatever they are (a panel or a whole nested split).
  function onResizeDown(splitId: string, index: number, dir: "row" | "column", event: ReactPointerEvent) {
    const handle = event.currentTarget as HTMLElement;
    const first = handle.previousElementSibling;
    const second = handle.nextElementSibling;
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
      return;
    }
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    resizeRef.current = {
      snapshot: layout,
      splitId,
      index,
      dir,
      start: dir === "row" ? event.clientX : event.clientY,
      pairPx: dir === "row" ? firstRect.width + secondRect.width : firstRect.height + secondRect.height,
      firstPx: dir === "row" ? firstRect.width : firstRect.height,
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp, { once: true });
    document.body.classList.add(dir === "row" ? "wb-resizing" : "wb-resizing-y");
  }

  function onResizeMove(event: PointerEvent) {
    const ref = resizeRef.current;
    if (!ref) {
      return;
    }
    const position = ref.dir === "row" ? event.clientX : event.clientY;
    // Clamped in pixels, on both sides, before it becomes a ratio — so neither
    // the slot being dragged nor its neighbour can be squeezed into a sliver.
    // A pair with no room for two minimums is left alone rather than fought over.
    const floor = Math.min(MIN_PANEL_PX, ref.pairPx / 2);
    const smallest = floor - ref.firstPx;
    const largest = ref.pairPx - floor - ref.firstPx;
    const deltaPx = Math.min(largest, Math.max(smallest, position - ref.start));
    setLayout(resizeSplit(ref.snapshot, ref.splitId, ref.index, deltaPx / Math.max(1, ref.pairPx)));
  }

  function onResizeUp() {
    window.removeEventListener("pointermove", onResizeMove);
    resizeRef.current = null;
    document.body.classList.remove("wb-resizing");
    document.body.classList.remove("wb-resizing-y");
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

  /**
   * The geometry to draw. A layout that carries no grid is one written before
   * grids existed, or by an older window on this party — it means a single row,
   * so that is what it gets rather than an empty work area.
   */
  const grid = useMemo(() => layout.grid || rowGrid(layout.panels), [layout]);
  const panelById = useMemo(() => new Map(layout.panels.map((panel) => [panel.id, panel])), [layout]);

  /**
   * Draws the split tree: a split becomes a flex box along its axis with a
   * divider between each pair of children, a leaf becomes its panel. Recursive
   * because the tree is — a column of two inside one half of a row is what makes
   * the layout a grid rather than a row.
   */
  function renderGrid(node: GridNode | undefined): ReactNode {
    if (!node) {
      return null;
    }
    if (node.type === "leaf") {
      const panel = panelById.get(node.panelId);
      return panel ? renderPanel(panel) : null;
    }
    return (
      <div
        key={node.id}
        className={"wb-split is-" + node.dir}
        data-split-id={node.id}
        style={{ flexGrow: node.weight, flexBasis: 0 }}
      >
        {node.children.map((child, index) => (
          <Fragment key={child.type === "leaf" ? child.panelId : child.id}>
            {index > 0 && (
              <div
                className={"wb-resize-handle is-" + node.dir}
                data-resize-split={node.id}
                data-resize-index={index - 1}
                onPointerDown={(event) => onResizeDown(node.id, index - 1, node.dir, event)}
              />
            )}
            {renderGrid(child)}
          </Fragment>
        ))}
      </div>
    );
  }

  function renderPanel(panel: PanelState): ReactNode {
    const over = Boolean(drag && !drag.overOuter && drag.overPanelId === panel.id);
    return (
      <Panel
        key={panel.id}
        panel={panel}
        views={viewMap}
        focused={panel.id === layout.focusedPanelId}
        draggingMember={drag?.member ?? null}
        // The middle of the panel means "join this group"; an edge means "split
        // here", and the two must not light up at once.
        dropTarget={over && !drag?.overSide}
        dropSide={over ? drag?.overSide ?? null : null}
        dropAt={over && drag?.overTab ? { tab: drag.overTab, after: Boolean(drag.overAfter) } : null}
        actions={actions}
        onFocus={() => setLayout((current) => focusPanel(current, panel.id))}
        onSelectTab={(member) => setLayout((current) => setActiveTab(current, panel.id, member))}
        onCloseTab={(member) => {
          // Closing the tab also closes the member's session (frees its
          // context + provider usage); it stays reopenable via the sidebar.
          //
          // Unless the member is STILL open in another slot: splitting a panel
          // puts the same member on show twice, and ending its session from one
          // of those would leave the other panel holding a dead tab.
          // Computed from the rendered layout rather than inside a state
          // updater: an updater must stay pure, and closing a session is not.
          const next = closeTab(layout, panel.id, member);
          if (!next.panels.some((item) => item.tabs.includes(member))) {
            actions.closeSession(member);
          }
          setLayout(next);
        }}
        onSplit={(side) => setLayout((current) => splitPanel(current, panel.id, side))}
        onPromoteTab={(member) => setLayout((current) => promoteTab(current, panel.id, member))}
        onOpenRuntime={setRuntimeTarget}
        onOpenPermissions={setPermissionTarget}
        onOpenMcp={setMcpTarget}
        onOpenStatus={setStatusTarget}
        onOpenCompact={setCompactTarget}
        onOpenUsage={onOpenUsage}
        onOpenGate={setGateTarget}
        onTabPointerDown={onTabPointerDown}
        chrome={{
          toolbar: Boolean(panelChrome[panel.active]?.toolbar),
          composer: Boolean(panelChrome[panel.active]?.composer),
        }}
        onToggleChrome={(which) => toggleChrome(panel.active, which)}
        openSubId={subUi.open[panel.active]}
        subDockCollapsed={subUi.collapsed[panel.active]}
        onToggleSubDock={() => toggleSubDock(panel.active)}
        onOpenSub={(id) => openSub(panel.active, id)}
        onCloseSub={() => closeSub(panel.active)}
      />
    );
  }
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
        tabGroups={layout.panels.map((panel) => ({
          id: panel.id,
          label: panel.tabs.join(" · "),
        }))}
        defaultTabGroupId={layout.focusedPanelId || undefined}
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
        {renderGrid(grid)}
        {drag?.overOuter && <div className={"wb-drop-outer is-" + drag.overOuter} />}
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
