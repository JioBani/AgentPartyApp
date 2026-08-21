import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsLeft, ChevronsRight, ExternalLink, FolderInput, Moon, PencilLine, Pin, Play, Plus, RotateCcw, Sun, Terminal, Trash2, UserRound, Users, X } from "lucide-react";
import type { DefaultMemberProfile, HarnessDefaults } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import type { PermissionModeSetting } from "../../shared/types";
import type { PartyGate } from "../../shared/messageGate";
import type { MemberView } from "./types";
import type { RouteLike } from "./routes";
import { memberColorVars } from "../theme/memberColors";
import { statusLabel } from "./memberStatus";
import { MemberWizard } from "./MemberWizard";
import { WorkingDots } from "./StatusIndicator";
import { harnessLabel } from "./harnessLabel";
import { HarnessIcon } from "./HarnessIcon";
import { MessageGateIcon } from "./MessageGateIcon";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { PartyGroupList } from "./PartyGroupList";
import { MoveGroupModal, NewGroupModal, RenameGroupModal } from "./PartyGroupModals";
import { CwdPicker, ENV_LABEL, EnvIcon, type WslBrowsing } from "./CwdPicker";
import type { PartyGroup, PartySummary } from "../../shared/partyGroups";
import { groupParties } from "../../shared/partyGroups";
import type { CwdPreferences, ExecutionEnv, MemberExecutionLocation } from "../../shared/memberLocation";
import { checkLocationShape, parseMemberLocation, suggestedCwd } from "../../shared/memberLocation";
import { SIDEBAR_DRAWER_MAX_WIDTH, SIDEBAR_DRAWER_MIN_WIDTH, type SidebarDrawerId, type SidebarDrawerSettings, type SidebarDrawerState } from "../../shared/sidebarDrawers";

export interface CreateMemberInput {
  name: string;
  requirement: string;
  runtime: string;
  model?: string;
  effort?: string;
  reasoning?: string;
  reasoningBudget?: number;
  serviceTier?: string;
  permissionMode?: PermissionModeSetting;
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
  /**
   * Where the member runs, fixed at creation. Required in practice — the wizard
   * will not advance without one — but optional on the type so an automation
   * caller that omits it is REJECTED with a reason rather than silently given
   * whatever cwd the app happened to be launched from.
   */
  location?: MemberExecutionLocation;
  /** Also store this location as the environment's default cwd. */
  saveAsDefault?: boolean;
}

interface PartySidebarProps {
  /** App-global groups, in display order. */
  groups: PartyGroup[];
  /** One summary per party — never a definition, so the list stays cheap. */
  partySummaries: PartySummary[];
  /** Default + recent cwds, offered when creating a party or a member. */
  cwdPrefs: CwdPreferences;
  appWorkspaceRoot: string;
  /** Frozen "now" for recency labels, so previews render deterministically. */
  now: number;
  activePartyId?: string;
  views: MemberView[];
  openMembers: Set<string>;
  routes: RouteLike[];
  /** Live Codex catalog discovery state, surfaced by the member wizard. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  defaultProfile: DefaultMemberProfile;
  harnessDefaults: Record<string, HarnessDefaults>;
  onSelectParty: (partyId: string) => void;
  onCreateParty: (input: CreatePartyInput) => void;
  onCreateGroup: (name: string) => void;
  onMovePartyToGroup: (partyId: string, groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onRemoveGroup: (groupId: string) => void;
  onReorderGroups: (order: string[]) => void;
  /** Opens the platform folder picker; resolves null when the user cancelled. */
  onBrowseCwd: (env: ExecutionEnv, distro?: string) => Promise<MemberExecutionLocation | null>;
  wsl?: WslBrowsing;
  onCreateMember: (input: CreateMemberInput) => void;
  onOpenMember: (member: string) => void;
  /** Hard restart (in-place harness restart); enabled only with a live session. */
  onRestartMember: (member: string) => void;
  onRemoveMember: (member: string) => void;
  /** Pins a member awake (true) or lets it follow the global idle-sleep policy. */
  onSetMemberKeepAwake: (member: string, keepAwake: boolean) => void;
  /** Releases a member's harness process now, keeping its conversation. */
  onSleepMember: (member: string) => void;
  /** Brings a sleeping member back and resumes its conversation. */
  onWakeMember: (member: string) => void;
  onRemoveParty: (partyId: string) => void;
  /** Opens the party-wide Message Gate manager for a party. */
  onOpenPartyGate: (partyId: string) => void;
  /** Opens the party in another window of this process (shared engine + sessions). */
  onOpenPartyInNewWindow: (partyId: string) => void;
  /** Drawer open/width state, and how to change it. Owned by the app shell. */
  drawers: SidebarDrawerSettings;
  onToggleDrawer: (which: SidebarDrawerId, patch: Partial<SidebarDrawerState>) => void;
}

/**
 * Everything creating a party now needs.
 *
 * `location` is the cwd of the `main` member that is created alongside it — the
 * party itself owns no directory (README §7). It travels in this payload rather
 * than being resolved later, so the party and its first member are decided in
 * one place instead of two that could disagree.
 */
export interface CreatePartyInput {
  name: string;
  groupId: string;
  location: MemberExecutionLocation;
  gate?: PartyGate;
}

/** The row the context menu was opened on, re-read live so its items reflect the
 *  member's current state rather than what it was at right-click time. */
function memberOf(views: MemberView[], name: string): MemberView | undefined {
  return views.find((view) => view.name === name);
}

/**
 * The member half of the sidebar's right-click menu.
 *
 * `view` is undefined only if the member vanished while the menu was open; the
 * items then read as unavailable rather than acting on a name that is gone.
 */
function MemberContextMenuItems({ name, view, location, onRestart, onSetKeepAwake, onSleep, onWake, onRemove, onDone }: {
  name: string;
  view: MemberView | undefined;
  /** The member's fixed cwd, shown read-only above the actions. */
  location?: MemberExecutionLocation;
  onRestart: (member: string) => void;
  onSetKeepAwake: (member: string, keepAwake: boolean) => void;
  onSleep: (member: string) => void;
  onWake: (member: string) => void;
  onRemove: (member: string) => void;
  onDone: () => void;
}) {
  const keepAwake = view?.member.keepAwake === true;
  const run = (action: () => void) => () => { action(); onDone(); };
  return (
    <>
      {/* Where this member runs, stated before any action is offered. It is the
          one property the menu cannot change, and a menu that showed only the
          changeable things would leave "why can I not move it?" unanswered. */}
      {location && (
        <div className="wb-ctx-head">
          <strong>{name}</strong>
          <span className="wb-ctx-head-loc">
            <EnvIcon env={location.env} />
            {location.distro && <span className="wb-cwd-distro">{location.distro}</span>}
            <span className="wb-mono">{location.cwd}</span>
          </span>
          <span><LocalizedText id="STR-3685" /></span>
        </div>
      )}
      <button
        type="button"
        className="wb-ctx-item"
        disabled={!view?.session}
        title={localized("STR-2047")}
        onClick={run(() => onRestart(name))}
      >
        <RotateCcw size={13} />  <LocalizedText id="STR-2048" />
      </button>
      {/* Idle sleep. The pin applies to any member, session or not; 재우기/깨우기
          is offered in whichever direction this member can actually go. */}
      <button
        type="button"
        className={"wb-ctx-item" + (keepAwake ? " is-on" : "")}
        title={localized("STR-2049")}
        onClick={run(() => onSetKeepAwake(name, !keepAwake))}
      >
        <Pin size={13} />  <LocalizedText id="STR-2050" />
        {keepAwake && <Check size={13} className="wb-ctx-check" />}
      </button>
      {view?.status === "closed" ? (
        // A closed member is the one state that will NOT start itself: prewarm
        // skips it and an auto-start refuses it, by design (closing is an
        // explicit "leave this alone"). So it needs an explicit way back, or a
        // tab closed in another window leaves this one with no working action.
        <button
          type="button"
          className="wb-ctx-item"
          title={localized("STR-2051")}
          onClick={run(() => onWake(name))}
        >
          <Play size={13} />  <LocalizedText id="STR-2052" />
        </button>
      ) : view?.status === "sleeping" ? (
        <button
          type="button"
          className="wb-ctx-item"
          title={localized("STR-2053")}
          onClick={run(() => onWake(name))}
        >
          <Sun size={13} />  <LocalizedText id="STR-2054" />
        </button>
      ) : (
        <button
          type="button"
          className="wb-ctx-item"
          disabled={!view?.session || keepAwake}
          title={localized("STR-2055")}
          onClick={run(() => onSleep(name))}
        >
          <Moon size={13} />  <LocalizedText id="STR-2056" />
        </button>
      )}
      {name !== "main" && (
        <button type="button" className="wb-ctx-item is-danger" onClick={run(() => onRemove(name))}>
          <Trash2 size={13} />  <LocalizedText id="STR-2057" />
        </button>
      )}
    </>
  );
}

/**
 * The group half of the sidebar's right-click menu.
 *
 * Deleting a group deletes a FOLDER, so the wording says where the parties go —
 * "그룹만 삭제" next to the count, not a bare "삭제" that reads like it takes the
 * parties with it. The default group has no delete item at all: something has
 * to be the place parties land, and a disabled row would only invite the click.
 */
function GroupContextMenuItems({ menu, confirming, onAddParty, onRename, onArmDelete, onDelete }: {
  menu: { groupId: string; name: string; isDefault: boolean };
  confirming: boolean;
  onAddParty: () => void;
  onRename: () => void;
  onArmDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="wb-ctx-head">
        <strong>{menu.name}</strong>
        <span><LocalizedText id="STR-3689" /></span>
      </div>
      <button type="button" className="wb-ctx-item" onClick={onAddParty}>
        <Plus size={13} />  <LocalizedText id="STR-3775" />
      </button>
      <button type="button" className="wb-ctx-item" onClick={onRename}>
        <PencilLine size={13} />  <LocalizedText id="STR-3776" />
      </button>
      {!menu.isDefault && (confirming ? (
        <button type="button" className="wb-ctx-item is-danger" onClick={onDelete}>
          <Trash2 size={13} />  <LocalizedText id="STR-3777" />
        </button>
      ) : (
        <button type="button" className="wb-ctx-item is-danger" onClick={onArmDelete}>
          <Trash2 size={13} />  <LocalizedText id="STR-3778" />
        </button>
      ))}
    </>
  );
}

// Right-click context menu target: a member row, a party row (which needs a
// confirm step because deleting a party cascades to all of its members), or a
// group header.
type CtxMenu =
  | { kind: "member"; name: string; x: number; y: number }
  | { kind: "party"; partyId: string; name: string; x: number; y: number }
  | { kind: "group"; groupId: string; name: string; isDefault: boolean; x: number; y: number };

interface PositionedCtxMenu {
  /** The exact menu state this measurement belongs to. */
  menu: CtxMenu;
  left: number;
  top: number;
}

const CONTEXT_MENU_VIEWPORT_GUTTER = 8;
const CONTEXT_MENU_ANCHOR_GAP = 4;

/**
 * Places a context menu next to its pointer anchor without clipping it.
 *
 * Opening direction is decided from the measured menu size, not a guessed
 * item count: member actions vary with session state and destructive actions
 * can change after the menu opens. If the menu does not fit below/right of the
 * pointer, it opens above/left, then clamps to the viewport as a final guard.
 */
function fitContextMenuToViewport(
  anchor: { x: number; y: number },
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(CONTEXT_MENU_VIEWPORT_GUTTER, viewport.width - menuSize.width - CONTEXT_MENU_VIEWPORT_GUTTER);
  const maxTop = Math.max(CONTEXT_MENU_VIEWPORT_GUTTER, viewport.height - menuSize.height - CONTEXT_MENU_VIEWPORT_GUTTER);
  const fitsRight = anchor.x + CONTEXT_MENU_ANCHOR_GAP + menuSize.width + CONTEXT_MENU_VIEWPORT_GUTTER <= viewport.width;
  const fitsBelow = anchor.y + CONTEXT_MENU_ANCHOR_GAP + menuSize.height + CONTEXT_MENU_VIEWPORT_GUTTER <= viewport.height;
  const preferredLeft = fitsRight ? anchor.x + CONTEXT_MENU_ANCHOR_GAP : anchor.x - menuSize.width - CONTEXT_MENU_ANCHOR_GAP;
  const preferredTop = fitsBelow ? anchor.y + CONTEXT_MENU_ANCHOR_GAP : anchor.y - menuSize.height - CONTEXT_MENU_ANCHOR_GAP;

  return {
    left: Math.round(Math.min(maxLeft, Math.max(CONTEXT_MENU_VIEWPORT_GUTTER, preferredLeft))),
    top: Math.round(Math.min(maxTop, Math.max(CONTEXT_MENU_VIEWPORT_GUTTER, preferredTop))),
  };
}

/**
 * Each drawer remembers its own width.
 *
 * Per drawer, not one shared number: the party list wants room for a group name
 * plus a count, the member list wants room for a name plus a status, and one
 * width forces the wider need on both.
 */

export function PartySidebar(props: PartySidebarProps) {
  const { groups, partySummaries, cwdPrefs, appWorkspaceRoot, now, activePartyId, views, openMembers, drawers, onToggleDrawer, routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, onSelectParty, onCreateParty, onCreateGroup, onMovePartyToGroup, onRenameGroup, onRemoveGroup, onReorderGroups, onBrowseCwd, wsl, onCreateMember, onOpenMember, onRestartMember, onRemoveMember, onSetMemberKeepAwake, onSleepMember, onWakeMember, onRemoveParty, onOpenPartyGate, onOpenPartyInNewWindow } = props;
  /**
   * The width being dragged RIGHT NOW, if any.
   *
   * The settled width lives in settings; a drag would otherwise write one
   * setting per pointer move. `undefined` means "no drag in flight, use the
   * stored width".
   */
  const [dragWidth, setDragWidth] = useState<{ which: SidebarDrawerId; width: number } | undefined>(undefined);
  const resizing = useRef<{ which: SidebarDrawerId; startX: number; startWidth: number } | null>(null);
  const widthOf = (which: SidebarDrawerId) => (dragWidth?.which === which ? dragWidth.width : drawers[which].width);
  const partyWidth = widthOf("party");
  const memberWidth = widthOf("member");

  /**
   * Drag-to-resize for one drawer.
   *
   * Listeners go on the window, not the handle: the pointer leaves a 4px strip
   * immediately, and a handle-scoped listener drops the drag the moment it does.
   */
  function startResize(which: SidebarDrawerId, event: React.PointerEvent) {
    resizing.current = { which, startX: event.clientX, startWidth: widthOf(which) };
    let latest = widthOf(which);
    const move = (moveEvent: PointerEvent) => {
      const ref = resizing.current;
      if (!ref) {
        return;
      }
      latest = Math.min(SIDEBAR_DRAWER_MAX_WIDTH, Math.max(SIDEBAR_DRAWER_MIN_WIDTH, ref.startWidth + (moveEvent.clientX - ref.startX)));
      setDragWidth({ which: ref.which, width: latest });
    };
    const up = () => {
      // Persisted once, at the end: the drag itself is local state, so a resize
      // is one settings write instead of one per pointer move.
      onToggleDrawer(which, { width: latest });
      setDragWidth(undefined);
      resizing.current = null;
      window.removeEventListener("pointermove", move);
      document.body.classList.remove("wb-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    document.body.classList.add("wb-resizing");
  }

  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [newPartyOpen, setNewPartyOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  /** The party the 그룹으로 이동 dialog is open for. */
  const [movingParty, setMovingParty] = useState<PartySummary | null>(null);
  // Right-click context menu, at the cursor, for a member or party row.
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<PositionedCtxMenu | null>(null);
  // Arms the second, confirming click for the destructive party delete.
  const [confirmParty, setConfirmParty] = useState(false);
  // Same two-step for deleting a group. Separate flag: one shared "confirm"
  // would carry an armed party delete over into a group menu.
  const [confirmGroup, setConfirmGroup] = useState(false);
  /** The group the 이름 변경 dialog is open for. */
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; name: string } | null>(null);
  /** Which group a new party should land in, when opened from a group's menu. */
  const [newPartyGroupId, setNewPartyGroupId] = useState<string | null>(null);
  /**
   * Which groups are expanded. Starts with every group open: a first run that
   * hid the parties behind three closed folders would look like an empty app.
   */
  const [closedGroupIds, setClosedGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const openGroupIds = useMemo(
    () => new Set(groups.map((group) => group.id).filter((id) => !closedGroupIds.has(id))),
    [groups, closedGroupIds],
  );
  const grouped = useMemo(() => groupParties(groups, partySummaries), [groups, partySummaries]);
  const partyCountByGroup = useMemo(
    () => Object.fromEntries(grouped.map((entry) => [entry.group.id, entry.parties.length])),
    [grouped],
  );
  /** The group a new party lands in by default: the one being viewed (README §4.2). */
  const activeGroupId = partySummaries.find((party) => party.id === activePartyId)?.groupId ?? groups[0]?.id ?? "";

  // Dismiss the context menu on any outside click, scroll, or Escape.
  useEffect(() => {
    if (!menu) {
      setConfirmParty(false);
      setConfirmGroup(false);
      return;
    }
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Measure the real rendered menu before paint. `visibility: hidden` on the
  // first render prevents a one-frame flash at the unadjusted cursor position.
  useLayoutEffect(() => {
    const element = contextMenuRef.current;
    if (!menu || !element) {
      return;
    }

    const position = () => {
      const bounds = element.getBoundingClientRect();
      const next = fitContextMenuToViewport(
        { x: menu.x, y: menu.y },
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setMenuPosition((current) => (
        current?.menu === menu && current.left === next.left && current.top === next.top
          ? current
          : { menu, ...next }
      ));
    };

    position();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(element);
    window.addEventListener("resize", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [menu]);

  /**
   * The one-line quick create. It still needs a cwd for the `main` member, so it
   * only completes when a Windows default exists; otherwise it hands over to the
   * full dialog rather than inventing a directory to run in.
   */
  function submit(event: FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) {
      return;
    }
    if (!cwdPrefs.windowsDefault) {
      setNewPartyOpen(true);
      return;
    }
    onCreateParty({ name, groupId: activeGroupId, location: cwdPrefs.windowsDefault });
    setDraft("");
  }

  function toggleGroup(groupId: string) {
    setClosedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  return (
    <>
      {drawers.party.open ? (
        <aside className="wb-drawer wb-party-drawer" style={{ width: partyWidth }}>
          <header className="wb-drawer-head">
            <Users size={14} />
            <span className="wb-drawer-title"><LocalizedText id="STR-3780" /></span>
            <span className="wb-mono wb-drawer-count">{partySummaries.length}</span>
            <button type="button" className="wb-icon-btn" title={localized("STR-2058")} onClick={() => onToggleDrawer("party", { open: false })}><ChevronsLeft size={15} /></button>
          </header>

          <section className="wb-sidebar-section">
            {/* The count and the name live in the drawer header now; what stays
                is the hint, because it is the whole point of the change: the
                list no longer depends on which directory the app was launched
                from. */}
            <p className="wb-drawer-hint"><LocalizedText id="STR-3686" /></p>
            <form className="wb-new-party" onSubmit={submit}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={localized("STR-2059")} />
          <button type="button" className="wb-icon-btn is-accent" title={localized("STR-2060")} onClick={() => setNewPartyOpen(true)}><Plus size={15} /></button>
        </form>
        <PartyGroupList
          groups={grouped}
          activePartyId={activePartyId}
          openGroupIds={openGroupIds}
          now={now}
          menuPartyId={menu?.kind === "party" ? menu.partyId : undefined}
          menuGroupId={menu?.kind === "group" ? menu.groupId : undefined}
          onToggleGroup={toggleGroup}
          onSelectParty={onSelectParty}
          onCreateGroup={() => setNewGroupOpen(true)}
          onDropParty={onMovePartyToGroup}
          onReorderGroups={onReorderGroups}
          onPartyContextMenu={(party, event) => {
            setConfirmParty(false);
            setMenu({ kind: "party", partyId: party.id, name: party.name, x: event.clientX, y: event.clientY });
          }}
          onGroupContextMenu={(group, event) => {
            setConfirmGroup(false);
            setMenu({ kind: "group", groupId: group.id, name: group.name, isDefault: group.kind === "default", x: event.clientX, y: event.clientY });
          }}
        />
          </section>
          <div className="wb-drawer-resize" title={localized("STR-2289")} onPointerDown={(event) => startResize("party", event)} />
        </aside>
      ) : (
        <button type="button" className="wb-drawer-rail is-party" title={localized("STR-2290")} onClick={() => onToggleDrawer("party", { open: true })}>
          <ChevronsRight size={13} />
          <span><LocalizedText id="STR-3781" /></span>
          <span className="wb-mono wb-drawer-rail-count">{partySummaries.length}</span>
        </button>
      )}

      {drawers.member.open ? (
        <aside className="wb-drawer wb-member-drawer" style={{ width: memberWidth }}>
          {/* Says what the drawer IS, like the party drawer above it. Which
              party these members belong to is the workbench header's job — it
              stays visible with either drawer collapsed. */}
          <header className="wb-drawer-head">
            <UserRound size={14} />
            <span className="wb-drawer-title"><LocalizedText id="STR-2061" /></span>
            <span className="wb-mono wb-drawer-count">{views.length}</span>
            <button type="button" className="wb-icon-btn" title={localized("STR-2058")} onClick={() => onToggleDrawer("member", { open: false })}><ChevronsLeft size={15} /></button>
          </header>

          <section className="wb-sidebar-section wb-members-section">
            <div className="wb-section-label">
          {!creating && <span className="wb-hint"><LocalizedText id="STR-2062" /></span>}
          <button type="button" className={"wb-icon-btn wb-section-add" + (creating ? " is-open" : "")} title={creating ? localized("STR-2064") : localized("STR-2063")} onClick={() => setCreating((value) => !value)}>
            {creating ? <X size={14} /> : <Plus size={15} />}
          </button>
        </div>

        {creating && (
          <MemberWizard
            routes={routes}
            codexModels={codexModels}
            onRefreshCodexModels={onRefreshCodexModels}
            defaultProfile={defaultProfile}
            harnessDefaults={harnessDefaults}
            cwdPrefs={cwdPrefs}
            appWorkspaceRoot={appWorkspaceRoot}
            now={now}
            onBrowseCwd={onBrowseCwd}
            wsl={wsl}
            onCancel={() => setCreating(false)}
            onCreate={(input) => { onCreateMember(input); setCreating(false); }}
          />
        )}

        <div className="wb-member-list">
          {views.length === 0 && <div className="wb-empty"><LocalizedText id="STR-2065" /></div>}
          {views.map((view) => {
            const removable = view.name !== "main";
            return (
              <div
                role="button"
                tabIndex={0}
                key={view.name}
                className={"wb-member-row" + (openMembers.has(view.name) ? " is-open" : "") + (menu?.kind === "member" && menu.name === view.name ? " is-menu" : "")}
                style={memberColorVars(view.name)}
                onClick={() => onOpenMember(view.name)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenMember(view.name); } }}
                onContextMenu={(event) => {
                  // Always worth showing now: 계속 켜두기 applies to any member,
                  // session or not, so there is no longer a case with nothing
                  // actionable in it.
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu({ kind: "member", name: view.name, x: event.clientX, y: event.clientY });
                }}
              >
                <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
                <span className="wb-member-name">{view.name}</span>
                {/* Which harness this member runs on. The same model behaves
                    differently per harness, so the model alone does not say what
                    a member is. Short here (the row is dense), full name on hover. */}
                <span className="wb-harness-chip" title={harnessLabel(view.member.runtime)} aria-label={harnessLabel(view.member.runtime)}>
                  <HarnessIcon harness={view.member.runtime} />
                </span>
                {view.pendingApproval && <span className="wb-member-badge"><LocalizedText id="STR-2066" /></span>}
                {view.unread > 0 && <span className="wb-mono wb-member-unread">{view.unread}</span>}
                {/* A running turn is motion, not the grey word "working" that
                    read as a label and was easy to miss down the list. */}
                {!view.pendingApproval && (view.status === "working"
                  ? <WorkingDots label={localized("STR-2067")} />
                  : <span className="wb-mono wb-member-status">{statusLabel(view.status)}</span>)}
              </div>
            );
          })}
            </div>
          </section>
          <div className="wb-drawer-resize" title={localized("STR-2289")} onPointerDown={(event) => startResize("member", event)} />
        </aside>
      ) : (
        <button type="button" className="wb-drawer-rail is-member" title={localized("STR-2290")} onClick={() => onToggleDrawer("member", { open: true })}>
          <ChevronsRight size={13} />
          <span><LocalizedText id="STR-2061" /></span>
          <span className="wb-mono wb-drawer-rail-count">{views.length}</span>
        </button>
      )}

      {menu && (
        <div
          ref={contextMenuRef}
          className="wb-ctx-menu"
          style={menuPosition?.menu === menu
            ? { left: menuPosition.left, top: menuPosition.top }
            : { left: menu.x, top: menu.y, visibility: "hidden" }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu.kind === "group" ? (
            <GroupContextMenuItems
              menu={menu}
              confirming={confirmGroup}
              onAddParty={() => { setNewPartyGroupId(menu.groupId); setNewPartyOpen(true); setMenu(null); }}
              onRename={() => { setRenamingGroup({ id: menu.groupId, name: menu.name }); setMenu(null); }}
              onArmDelete={() => setConfirmGroup(true)}
              onDelete={() => { onRemoveGroup(menu.groupId); setMenu(null); }}
            />
          ) : menu.kind === "member" ? (
            <MemberContextMenuItems
              name={menu.name}
              view={memberOf(views, menu.name)}
              location={(() => {
                const stored = memberOf(views, menu.name)?.member.location;
                return stored ? parseMemberLocation(stored) : undefined;
              })()}
              onRestart={onRestartMember}
              onSetKeepAwake={onSetMemberKeepAwake}
              onSleep={onSleepMember}
              onWake={onWakeMember}
              onRemove={onRemoveMember}
              onDone={() => setMenu(null)}
            />
          ) : (
            <>
              {/* Opens the party in ANOTHER window of this same process, which is
                  what makes running several parties at once cheap: they share one
                  engine and one harness per member. Deliberately does NOT select
                  the party here — this window stays where it is. */}
              <button
                type="button"
                className="wb-ctx-item"
                title={localized("STR-2068")}
                onClick={() => { onOpenPartyInNewWindow(menu.partyId); setMenu(null); }}
              >
                <ExternalLink size={13} />  <LocalizedText id="STR-2069" />
              </button>
              <button
                type="button"
                className="wb-ctx-item"
                title={localized("STR-2070")}
                onClick={() => { onSelectParty(menu.partyId); onOpenPartyGate(menu.partyId); setMenu(null); }}
              >
                <MessageGateIcon size={13} className="wb-gate-accent" />  <LocalizedText id="STR-2071" />
              </button>
              <button
                type="button"
                className="wb-ctx-item"
                title={localized("STR-3687")}
                onClick={() => {
                  const party = partySummaries.find((entry) => entry.id === menu.partyId);
                  if (party) {
                    setMovingParty(party);
                  }
                  setMenu(null);
                }}
              >
                <FolderInput size={13} />  <LocalizedText id="STR-3688" />
              </button>
              {confirmParty ? (
                <button
                  type="button"
                  className="wb-ctx-item is-danger"
                  onClick={() => { onRemoveParty(menu.partyId); setMenu(null); }}
                >
                  <Trash2 size={13} />  <LocalizedText id="STR-2072" />
                </button>
              ) : (
                <button
                  type="button"
                  className="wb-ctx-item is-danger"
                  onClick={() => setConfirmParty(true)}
                >
                  <Trash2 size={13} />  <LocalizedText id="STR-2073" />
                </button>
              )}
            </>
          )}
        </div>
      )}

      {renamingGroup && (
        <RenameGroupModal
          group={renamingGroup}
          onCancel={() => setRenamingGroup(null)}
          onRename={(name) => { onRenameGroup(renamingGroup.id, name); setRenamingGroup(null); }}
        />
      )}

      {newPartyOpen && (
        <NewPartyModal
          initialName={draft}
          groups={groups}
          initialGroupId={newPartyGroupId ?? activeGroupId}
          cwdPrefs={cwdPrefs}
          appWorkspaceRoot={appWorkspaceRoot}
          now={now}
          onBrowseCwd={onBrowseCwd}
          wsl={wsl}
          onCreateGroup={() => { setNewPartyOpen(false); setNewGroupOpen(true); }}
          onCancel={() => { setNewPartyOpen(false); setNewPartyGroupId(null); }}
          onCreate={(input) => { onCreateParty(input); setDraft(""); setNewPartyOpen(false); setNewPartyGroupId(null); }}
        />
      )}

      {newGroupOpen && (
        <NewGroupModal
          onCancel={() => setNewGroupOpen(false)}
          onCreate={(name) => { onCreateGroup(name); setNewGroupOpen(false); }}
        />
      )}

      {movingParty && (
        <MoveGroupModal
          party={movingParty}
          groups={groups}
          partyCountByGroup={partyCountByGroup}
          onCancel={() => setMovingParty(null)}
          onMove={(groupId) => { onMovePartyToGroup(movingParty.id, groupId); setMovingParty(null); }}
        />
      )}
    </>
  );
}

/**
 * New-party creation modal (opened by the accent +).
 *
 * Three questions: what the party is called, which group it goes in, and where
 * its `main` member will run. The party itself owns no directory — the cwd here
 * belongs to `main`, and the hint says so, because "새 파티 · 경로" reads like
 * the party has a workspace and that idea is exactly what this change removes.
 *
 * Closes ONLY via Cancel — never an outside click.
 */
export function NewPartyModal({ initialName, groups, initialGroupId, cwdPrefs, appWorkspaceRoot, now, onBrowseCwd, wsl, onCreateGroup, onCancel, onCreate }: {
  initialName: string;
  groups: PartyGroup[];
  initialGroupId: string;
  cwdPrefs: CwdPreferences;
  appWorkspaceRoot: string;
  now: number;
  onBrowseCwd: (env: ExecutionEnv, distro?: string) => Promise<MemberExecutionLocation | null>;
  wsl?: WslBrowsing;
  /** Chosen from the group dropdown's last entry; hands over to the group dialog. */
  onCreateGroup: () => void;
  onCancel: () => void;
  onCreate: (input: CreatePartyInput) => void;
}) {
  const [name, setName] = useState(initialName);
  const [groupId, setGroupId] = useState(initialGroupId || groups[0]?.id || "");
  const [location, setLocation] = useState<MemberExecutionLocation | undefined>(() => suggestedCwd(cwdPrefs, "windows", appWorkspaceRoot));
  const [gateOn, setGateOn] = useState(false);
  const [rule, setRule] = useState("간결하게 보내세요. 오케스트레이터를 거치지 말고 담당 멤버에게 직접 소통하세요.");
  // A party cannot be created without somewhere for `main` to run (README §7).
  const locationProblem = location ? checkLocationShape(location) : undefined;
  const canCreate = name.trim().length > 0 && Boolean(location?.cwd) && !locationProblem;

  function create() {
    if (!canCreate || !location) {
      return;
    }
    onCreate({ name: name.trim(), groupId, location, gate: gateOn ? { enabled: true, rule } : undefined });
  }

  function changeEnv(env: ExecutionEnv) {
    setLocation(suggestedCwd(cwdPrefs, env, appWorkspaceRoot) ?? { env, cwd: "" });
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-new-party-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <Users size={16} />
            <strong><LocalizedText id="STR-2075" /></strong>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-2076")} onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-modal-label"><LocalizedText id="STR-2077" /></div>
          <input
            className="wb-gate-name-input"
            value={name}
            autoFocus
            placeholder={localized("STR-2078")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") create(); }}
          />

          <div className="wb-modal-label"><LocalizedText id="STR-3689" /></div>
          <select
            className="wb-wizard-input wb-group-select"
            value={groupId}
            onChange={(event) => {
              if (event.target.value === "__new") {
                onCreateGroup();
                return;
              }
              setGroupId(event.target.value);
            }}
          >
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            <option value="__new">{localized("STR-3690")}</option>
          </select>

          <div className="wb-modal-label"><LocalizedText id="STR-3691" /></div>
          <CwdPicker
            value={location}
            prefs={cwdPrefs}
            now={now}
            onChange={setLocation}
            onChangeEnv={changeEnv}
            onBrowse={() => { void onBrowseCwd(location?.env ?? "windows", location?.distro).then((picked) => { if (picked) setLocation(picked); }); }}
            wsl={wsl}
            hint={<><LocalizedText id="STR-3693" /> <b>main</b> <LocalizedText id="STR-3692" /></>}
          />
          {locationProblem && <p className="wb-wizard-error">{locationProblem.message}</p>}

          <div className="wb-gate-block">
            <label className="wb-gate-toggle-row">
              <span className="wb-gate-toggle-text">
                <span className="wb-gate-tile"><MessageGateIcon size={17} /></span>
                <span>
                  <strong><LocalizedText id="STR-2079" /></strong>
                  <small><LocalizedText id="STR-2080" /></small>
                </span>
              </span>
              <input type="checkbox" className="wb-switch" checked={gateOn} onChange={(event) => setGateOn(event.target.checked)} />
            </label>
            {gateOn && (
              <>
                <div className="wb-modal-label"><LocalizedText id="STR-2081" /></div>
                <textarea className="wb-gate-textarea" rows={4} value={rule} onChange={(event) => setRule(event.target.value)} />
                <div className="wb-gate-note"><LocalizedText id="STR-2082" /></div>
              </>
            )}
          </div>
        </div>
        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-2083" /></button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!canCreate} onClick={create}><LocalizedText id="STR-2084" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}
