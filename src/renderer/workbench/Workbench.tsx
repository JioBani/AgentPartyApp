import { Fragment, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import type { DefaultMemberProfile, HarnessDefaults, PartyDefinition } from "../../shared/types";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import { RouteLike } from "./routes";
import { memberColor, memberColorVars } from "../theme/memberColors";
import {
  LayoutState,
  closeTab,
  emptyLayout,
  focusPanel,
  layoutFromPanels,
  loadLayout,
  moveTab,
  moveTabToNewPanel,
  openMember,
  openMemberInNewPanel,
  panelOf,
  pruneLayout,
  resizeAt,
  saveLayout,
  setActiveTab,
  splitPanel,
} from "./layout";
import { Panel } from "./Panel";
import { CreateMemberInput, PartySidebar } from "./PartySidebar";
import { RuntimeModal } from "./RuntimeModal";
import { McpModal } from "./McpModal";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";

interface WorkbenchProps {
  parties: PartyDefinition[];
  activePartyId?: string;
  views: MemberView[];
  routes: RouteLike[];
  /** Live Codex catalog discovery state, surfaced by the member wizard. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  defaultProfile: DefaultMemberProfile;
  /** Per-harness creation defaults, so the wizard seeds each harness's default. */
  harnessDefaults: Record<string, HarnessDefaults>;
  debugEnabled: boolean;
  sidebarOpen: boolean;
  /** QA-driven panel arrangement; applied whenever `nonce` changes. */
  layoutRequest?: { panels: string[][]; nonce: number } | null;
  actions: WorkbenchActions;
  onCreateParty: (name: string) => void;
  onCreateMember: (input: CreateMemberInput) => void;
  onRemoveMember: (member: string) => void;
  onRemoveParty: (partyId: string) => void;
  onSelectParty: (partyId: string) => void;
  onMemberOpened: (member: string) => void;
  onVisibleMembersChange: (members: string[]) => void;
  onToggleSidebar: (open: boolean) => void;
}

interface DragState {
  member: string;
  x: number;
  y: number;
  overPanelId?: string;
  overTab?: string;
  overNew: boolean;
}

const DRAG_THRESHOLD = 5;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 460;
const SIDEBAR_WIDTH_KEY = "agentparty.sidebarWidth";

function loadSidebarWidth(): number {
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : 236;
}

function saveSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // Best-effort.
  }
}

export function Workbench(props: WorkbenchProps) {
  const { parties, activePartyId, views, routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, debugEnabled, sidebarOpen, layoutRequest, actions, onCreateParty, onCreateMember, onRemoveMember, onRemoveParty, onSelectParty, onMemberOpened, onVisibleMembersChange, onToggleSidebar } = props;

  const viewMap = useMemo(() => new Map(views.map((view) => [view.name, view])), [views]);
  const validMembers = useMemo(() => new Set(views.map((view) => view.name)), [views]);
  const partyKey = activePartyId || "default";

  const [layout, setLayout] = useState<LayoutState>(() => seedLayout(partyKey, views));
  const [runtimeTarget, setRuntimeTarget] = useState<string | null>(null);
  const [mcpTarget, setMcpTarget] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);

  const workAreaRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ member: string; x: number; y: number; active: boolean } | null>(null);
  const resizeRef = useRef<{ snapshot: LayoutState; leftId: string; rightId: string; startX: number; pairPx: number } | null>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Tracks members already seen for the current party, so only members created
  // *after* the party is showing auto-open (initial load / party-switch don't).
  const knownMembersRef = useRef<{ partyKey: string; names: Set<string> }>({ partyKey: "", names: new Set() });

  useEffect(() => {
    saveSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  function onSidebarResizeDown(event: ReactPointerEvent) {
    sidebarResizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    window.addEventListener("pointermove", onSidebarResizeMove);
    window.addEventListener("pointerup", onSidebarResizeUp, { once: true });
    document.body.classList.add("wb-resizing");
  }

  function onSidebarResizeMove(event: PointerEvent) {
    const ref = sidebarResizeRef.current;
    if (!ref) {
      return;
    }
    const next = ref.startWidth + (event.clientX - ref.startX);
    setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)));
  }

  function onSidebarResizeUp() {
    window.removeEventListener("pointermove", onSidebarResizeMove);
    sidebarResizeRef.current = null;
    document.body.classList.remove("wb-resizing");
  }

  // Reseed when the active party changes (each party has its own layout).
  useEffect(() => {
    setLayout(seedLayout(partyKey, views));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyKey]);

  // Drop tabs for members that no longer exist; persist after every change.
  useEffect(() => {
    setLayout((current) => {
      const pruned = pruneLayout(current, validMembers);
      return sameLayout(pruned, current) ? current : pruned;
    });
  }, [validMembers]);

  // Auto-open members created while this party is showing, each in its OWN new
  // panel (a fresh region) so it goes live immediately instead of to background.
  // A party switch / first mount only seeds the baseline — it does not auto-open.
  useEffect(() => {
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
    saveLayout(partyKey, layout);
    onVisibleMembersChange(layout.panels.map((panel) => panel.active).filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, partyKey]);

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
    onCreateMember(input);
    // The new member is opened in its own panel by the new-member effect below,
    // once it arrives via the party broadcast (uniform for wizard + agent creates).
  }

  function addFirstAvailable(panelId: string) {
    const open = new Set(layout.panels.flatMap((panel) => panel.tabs));
    const candidate = views.find((view) => !open.has(view.name));
    if (!candidate) {
      return;
    }
    setLayout((current) => openMember(focusPanel(current, panelId), candidate.name));
    onMemberOpened(candidate.name);
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
    setDrag({ member: start.member, x: event.clientX, y: event.clientY, overPanelId: hit.panelId, overTab: hit.tab, overNew: hit.newPanel });
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
        const { member, overPanelId, overTab, overNew } = current;
        if (overNew) {
          setLayout((state) => moveTabToNewPanel(state, member, overPanelId));
        } else if (overPanelId) {
          setLayout((state) => moveTab(state, member, overPanelId, overTab));
        }
      }
      return null;
    });
  }

  function hitTest(x: number, y: number): { panelId?: string; tab?: string; newPanel: boolean } {
    const stack = document.elementsFromPoint(x, y);
    let panelId: string | undefined;
    let tab: string | undefined;
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
      }
      if (!panelId && element.dataset.panelId) {
        panelId = element.dataset.panelId;
      }
    }
    return { panelId, tab, newPanel };
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
      window.removeEventListener("pointermove", onSidebarResizeMove);
      document.body.classList.remove("wb-resizing");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openMembers = useMemo(() => new Set(layout.panels.flatMap((panel) => panel.tabs)), [layout]);
  const activePartyName = parties.find((party) => party.id === activePartyId)?.name || "No Party";
  const runtimeView = runtimeTarget ? viewMap.get(runtimeTarget) : undefined;
  const mcpView = mcpTarget ? viewMap.get(mcpTarget) : undefined;
  const canAddAny = views.some((view) => !openMembers.has(view.name));

  const { workingByParty, memberCountByParty } = useMemo(() => aggregateByParty(views, parties), [views, parties]);

  return (
    <div className="wb-root">
      {sidebarOpen ? (
        <>
          <PartySidebar
            parties={parties}
            activePartyId={activePartyId}
            activePartyName={activePartyName}
            views={views}
            openMembers={openMembers}
            workingByParty={workingByParty}
            memberCountByParty={memberCountByParty}
            width={sidebarWidth}
            routes={routes}
            codexModels={codexModels}
            onRefreshCodexModels={onRefreshCodexModels}
            defaultProfile={defaultProfile}
            harnessDefaults={harnessDefaults}
            onSelectParty={onSelectParty}
            onCreateParty={onCreateParty}
            onCreateMember={handleCreateMember}
            onOpenMember={handleOpenMember}
            onRemoveMember={onRemoveMember}
            onRemoveParty={onRemoveParty}
            onCollapse={() => onToggleSidebar(false)}
          />
          <div className="wb-sidebar-resize" title="사이드바 너비 조정" onPointerDown={onSidebarResizeDown} />
        </>
      ) : (
        <button type="button" className="wb-sidebar-reopen" title="파티 패널 열기" onClick={() => onToggleSidebar(true)}>
          <PanelLeftOpen size={16} />
        </button>
      )}

      <div className={"wb-workarea" + (drag ? " is-dragging" : "")} ref={workAreaRef}>
        {layout.panels.length === 0 && (
          <div className="wb-workarea-empty">
            <p>왼쪽에서 멤버를 클릭해 패널로 열어 시작하세요.</p>
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
              canAdd={canAddAny}
              actions={actions}
              onFocus={() => setLayout((current) => focusPanel(current, panel.id))}
              onSelectTab={(member) => setLayout((current) => setActiveTab(current, panel.id, member))}
              onCloseTab={(member) => setLayout((current) => closeTab(current, panel.id, member))}
              onAdd={() => addFirstAvailable(panel.id)}
              onSplit={() => setLayout((current) => splitPanel(current, panel.id))}
              onOpenRuntime={setRuntimeTarget}
              onOpenMcp={setMcpTarget}
              onTabPointerDown={onTabPointerDown}
            />
          </Fragment>
        ))}
        {drag && (
          <div className={"wb-newpanel-zone" + (drag.overNew ? " is-over" : "")} data-drop-newpanel="1">
            <span>여기에 놓아 새 패널 만들기</span>
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

      {mcpView && (
        <McpModal
          view={mcpView}
          actions={actions}
          onClose={() => setMcpTarget(null)}
        />
      )}
    </div>
  );
}

function seedLayout(partyKey: string, views: MemberView[]): LayoutState {
  const stored = loadLayout(partyKey);
  if (stored && stored.panels.length > 0) {
    return pruneLayout(stored, new Set(views.map((view) => view.name)));
  }
  const first = views[0];
  if (!first) {
    return emptyLayout();
  }
  return openMember(emptyLayout(), first.name);
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
