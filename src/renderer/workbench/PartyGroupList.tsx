import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderOpen, FolderPlus, Plus } from "lucide-react";
import type { PartyGroupView, PartySummary } from "../../shared/partyGroups";
import { partySummaryLine } from "../../shared/partyGroups";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The sidebar's party list, one folder level deep.
 *
 * Reads summaries only — never a `PartyDefinition`, never a transcript. That is
 * the whole point of the group list: it must be drawable for a hundred parties
 * without opening any of them, so the props here are exactly what a summary
 * store can answer (README §4.3, §9).
 *
 * Presentational: open/closed groups, the active party and every action arrive
 * from the caller, which is what lets the design preview render a collapsed
 * group, an empty group and a running party side by side with no store at all.
 *
 * Dragging a party onto another group moves it there. The drag payload is a
 * custom MIME type rather than `text/plain`: a party id dropped into a composer
 * or an editor as text would be gibberish, and this way nothing outside the
 * sidebar accepts it.
 */

/** Identifies our own drags, so nothing else on the page accepts the drop. */
const PARTY_DRAG_TYPE = "application/x-agentparty-party";
/** A group being dragged to a new position. Distinct type, so one dragover can
 *  tell "file this party here" from "put this folder here". */
const GROUP_DRAG_TYPE = "application/x-agentparty-group";

export interface PartyGroupListProps {
  groups: PartyGroupView[];
  activePartyId?: string;
  /** Ids of the groups currently expanded. */
  openGroupIds: ReadonlySet<string>;
  /** Frozen "now" for the recency column, so previews render deterministically. */
  now: number;
  onToggleGroup: (groupId: string) => void;
  onSelectParty: (partyId: string) => void;
  onPartyContextMenu?: (party: PartySummary, event: React.MouseEvent) => void;
  onGroupContextMenu?: (group: PartyGroupView["group"], event: React.MouseEvent) => void;
  /** Drop of a dragged party onto a group. Never called for the group it is in. */
  onDropParty?: (partyId: string, groupId: string) => void;
  /** The whole new order, first to last, after a group was dragged. */
  onReorderGroups?: (order: string[]) => void;
  onCreateGroup: () => void;
  /** Opens the existing new-party flow with this group preselected. */
  onCreateParty?: (groupId: string) => void;
  /** Prevents a second create flow while one is already being submitted. */
  createPartyDisabled?: boolean;
  /** Marks the party row the context menu is currently open on. */
  menuPartyId?: string;
  /** Marks the group the context menu is currently open on. */
  menuGroupId?: string;
}

export function PartyGroupList({
  groups, activePartyId, openGroupIds, now, onToggleGroup, onSelectParty,
  onPartyContextMenu, onGroupContextMenu, onDropParty, onReorderGroups, onCreateGroup, onCreateParty,
  createPartyDisabled = false, menuPartyId, menuGroupId,
}: PartyGroupListProps) {
  /** The group under the pointer during a drag, for the drop outline. */
  const [dropGroupId, setDropGroupId] = useState<string | undefined>(undefined);
  /** The party being dragged, so its own group does not offer itself as a target. */
  const [draggingPartyId, setDraggingPartyId] = useState<string | undefined>(undefined);
  /** The group being dragged, and where it would land, for the insertion line. */
  const [draggingGroupId, setDraggingGroupId] = useState<string | undefined>(undefined);
  const [reorderTarget, setReorderTarget] = useState<{ groupId: string; after: boolean } | undefined>(undefined);

  /**
   * A group created while the list was scrolled down lands at the top, out of
   * sight, and looks like nothing happened. Scrolling to it is keyed on an id
   * the list has never seen — a REORDER moves no new id in, so dragging a group
   * to the top does not yank the view along with it.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Where the user last left the list, for the reorder restore below. */
  const lastScrollTop = useRef(0);
  /** Pointer position + animation owned by an in-flight native HTML drag. */
  const dragPointerY = useRef<number | undefined>(undefined);
  const dragScrollFrame = useRef<number | undefined>(undefined);
  const seenGroupIds = useRef<Set<string> | undefined>(undefined);

  function stopDragScroll() {
    dragPointerY.current = undefined;
    if (dragScrollFrame.current !== undefined) {
      cancelAnimationFrame(dragScrollFrame.current);
      dragScrollFrame.current = undefined;
    }
  }

  /**
   * Keeps scrolling while a carried party/group is held near either edge.
   * Relying on sporadic `dragover` events moved only a few pixels and made a
   * group outside the viewport unreachable; an animation frame continues until
   * the pointer leaves the edge or the drag ends.
   */
  function runDragScrollFrame() {
    dragScrollFrame.current = undefined;
    const box = scrollRef.current;
    const pointerY = dragPointerY.current;
    if (!box || pointerY === undefined) return;
    const bounds = box.getBoundingClientRect();
    const edge = Math.min(64, Math.max(32, bounds.height / 4));
    let delta = 0;
    if (pointerY < bounds.top + edge) {
      const strength = Math.min(1, Math.max(0, (bounds.top + edge - pointerY) / edge));
      delta = -Math.ceil(3 + strength * 15);
    } else if (pointerY > bounds.bottom - edge) {
      const strength = Math.min(1, Math.max(0, (pointerY - (bounds.bottom - edge)) / edge));
      delta = Math.ceil(3 + strength * 15);
    }
    if (!delta) return;
    const before = box.scrollTop;
    box.scrollTop += delta;
    lastScrollTop.current = box.scrollTop;
    // Stop at the physical end; a fresh dragover restarts if layout changes.
    if (box.scrollTop !== before) {
      dragScrollFrame.current = requestAnimationFrame(runDragScrollFrame);
    }
  }

  function updateDragScroll(event: React.DragEvent<HTMLDivElement>) {
    const ours = event.dataTransfer.types.includes(PARTY_DRAG_TYPE)
      || event.dataTransfer.types.includes(GROUP_DRAG_TYPE);
    if (!ours) return;
    dragPointerY.current = event.clientY;
    if (dragScrollFrame.current === undefined) {
      dragScrollFrame.current = requestAnimationFrame(runDragScrollFrame);
    }
  }

  useEffect(() => stopDragScroll, []);
  useEffect(() => {
    const ids = groups.map(({ group }) => group.id);
    // The first render establishes the baseline; nothing is "new" yet.
    if (!seenGroupIds.current) {
      seenGroupIds.current = new Set(ids);
      return;
    }
    // A UNION that never forgets, rather than "the ids of the previous render".
    // A refresh renders an empty list for one frame, and a baseline rebuilt from
    // that frame makes every group look new — which scrolled the list to the top
    // on a plain reorder.
    const isNew = ids.length > 0 && !seenGroupIds.current.has(ids[0]);
    for (const id of ids) {
      seenGroupIds.current.add(id);
    }
    if (isNew) {
      scrollRef.current?.scrollTo({ top: 0 });
      // Recorded HERE, not left to the scroll event: that event lands a frame
      // later, and a re-render in between would see "top, but the user was at
      // 465" and helpfully undo the scroll we just made.
      lastScrollTop.current = 0;
    }
  }, [groups]);

  /**
   * Puts the scroll position back after a reorder.
   *
   * Nothing scrolls the box — the BROWSER drops the position when the group
   * nodes are moved: the children leave the box one at a time, it briefly has
   * less content than scroll offset, and the offset clamps to 0. Measured, not
   * assumed: an instrumented `scrollTop` setter records no write, and the box
   * still ends up at 0. Runs before paint so the jump is never drawn.
   */
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box && box.scrollTop === 0 && lastScrollTop.current > 0) {
      box.scrollTop = lastScrollTop.current;
    }
  }, [groups]);

  /** The order the list would have if the drag were dropped right now. */
  function orderAfterDrop(dragged: string, target: string, after: boolean): string[] {
    const ids = groups.map(({ group }) => group.id).filter((id) => id !== dragged);
    const at = ids.indexOf(target);
    ids.splice(at < 0 ? ids.length : at + (after ? 1 : 0), 0, dragged);
    return ids;
  }

  const groupOf = (partyId: string) => groups.find(({ parties }) => parties.some((party) => party.id === partyId))?.group.id;
  /**
   * Whether a group will take THIS drag.
   *
   * Decided from the event's own payload types, not from React state: the first
   * `dragover` can arrive in the same tick as `dragstart`, before a state update
   * has rendered, and a target that refuses that frame refuses the drop.
   * `dataTransfer` only exposes types (not values) mid-drag, which is exactly
   * the question here — "is this one of ours?".
   */
  const accepts = (event: React.DragEvent) => Boolean(onDropParty) && event.dataTransfer.types.includes(PARTY_DRAG_TYPE);
  const acceptsGroup = (event: React.DragEvent) => Boolean(onReorderGroups) && event.dataTransfer.types.includes(GROUP_DRAG_TYPE);

  return (
    <div className="wb-party-list">
      {/* The create button heads the list and does NOT scroll, because a new
          group is created at the top too: the button sits where its result
          appears. */}
      <button type="button" className="wb-group-add" onClick={onCreateGroup}>
        <FolderPlus size={13} />
        <LocalizedText id="STR-3668" />
      </button>
      <div
        className="wb-party-scroll"
        ref={scrollRef}
        onScroll={(event) => { lastScrollTop.current = event.currentTarget.scrollTop; }}
        onDragOver={updateDragScroll}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopDragScroll();
        }}
        onDrop={stopDragScroll}
      >
      {groups.map(({ group, parties }) => {
        const open = openGroupIds.has(group.id);
        return (
          <div
            key={group.id}
            className={
              "wb-party-group"
              + (open ? " is-open" : "")
              + (dropGroupId === group.id ? " is-drop-target" : "")
              + (draggingGroupId === group.id ? " is-dragging" : "")
              + (reorderTarget?.groupId === group.id ? (reorderTarget.after ? " is-insert-after" : " is-insert-before") : "")
              + (group.id === menuGroupId ? " is-menu" : "")
            }
            onDragOver={(event) => {
              // A GROUP being dragged reorders; a PARTY being dragged is filed.
              // Two payload types, so one handler tells them apart without
              // asking any state what is currently in flight.
              if (acceptsGroup(event)) {
                if (draggingGroupId === group.id) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const box = event.currentTarget.getBoundingClientRect();
                setReorderTarget({ groupId: group.id, after: event.clientY > box.top + box.height / 2 });
                return;
              }
              // The group the party already sits in is not a target; it is where
              // the drag started.
              if (!accepts(event) || (draggingPartyId && groupOf(draggingPartyId) === group.id)) {
                return;
              }
              // Without preventDefault the browser refuses the drop entirely.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropGroupId(group.id);
            }}
            onDragLeave={(event) => {
              // Moving onto a CHILD also fires dragleave; only a leave that
              // actually exits the group box should clear the outline.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropGroupId((current) => (current === group.id ? undefined : current));
                setReorderTarget((current) => (current?.groupId === group.id ? undefined : current));
              }
            }}
            onDrop={(event) => {
              const movedGroup = event.dataTransfer.getData(GROUP_DRAG_TYPE);
              if (movedGroup && onReorderGroups) {
                event.preventDefault();
                const target = reorderTarget;
                setReorderTarget(undefined);
                setDraggingGroupId(undefined);
                if (movedGroup !== group.id) {
                  onReorderGroups(orderAfterDrop(movedGroup, group.id, Boolean(target?.after)));
                }
                return;
              }
              const partyId = event.dataTransfer.getData(PARTY_DRAG_TYPE);
              setDropGroupId(undefined);
              // Now the id IS readable, so "already here" is answered for real
              // rather than from whatever the drag state happened to hold.
              if (!partyId || !onDropParty || groupOf(partyId) === group.id) {
                return;
              }
              event.preventDefault();
              onDropParty(partyId, group.id);
            }}
          >
            <button
              type="button"
              className="wb-group-row"
              title={localized("STR-3665")}
              aria-expanded={open}
              draggable={Boolean(onReorderGroups)}
              onDragStart={(event) => {
                event.dataTransfer.setData(GROUP_DRAG_TYPE, group.id);
                event.dataTransfer.effectAllowed = "move";
                setDraggingGroupId(group.id);
              }}
              onDragEnd={() => { stopDragScroll(); setDraggingGroupId(undefined); setReorderTarget(undefined); }}
              onClick={() => onToggleGroup(group.id)}
              onContextMenu={(event) => {
                if (!onGroupContextMenu) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                onGroupContextMenu(group, event);
              }}
            >
              <ChevronDown size={13} className="wb-group-caret" />
              {open ? <FolderOpen size={14} className="wb-group-icon" /> : <Folder size={14} className="wb-group-icon" />}
              <span className="wb-group-name">{group.name}</span>
              {group.kind === "default" && <span className="wb-group-badge"><LocalizedText id="STR-3666" /></span>}
              <span className="wb-mono wb-group-count">{parties.length}</span>
            </button>
            <div className="wb-group-parties">
              {onCreateParty && (
                <button
                  type="button"
                  className="wb-group-add wb-party-add"
                  title={localized("STR-2084")}
                  aria-label={`${localized("STR-2084")}: ${group.name}`}
                  disabled={createPartyDisabled}
                  onClick={() => onCreateParty(group.id)}
                >
                  <Plus size={13} />
                  <LocalizedText id="STR-2084" />
                </button>
              )}
              {parties.map((party) => (
                <button
                  type="button"
                  key={party.id}
                  data-party-id={party.id}
                  className={
                    "wb-party-row"
                    + (party.id === activePartyId ? " is-active" : "")
                    + (party.id === menuPartyId ? " is-menu" : "")
                    + (party.id === draggingPartyId ? " is-dragging" : "")
                  }
                  draggable={Boolean(onDropParty)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(PARTY_DRAG_TYPE, party.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDraggingPartyId(party.id);
                  }}
                  onDragEnd={() => { stopDragScroll(); setDraggingPartyId(undefined); setDropGroupId(undefined); }}
                  onClick={() => onSelectParty(party.id)}
                  onContextMenu={(event) => {
                    if (!onPartyContextMenu) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    onPartyContextMenu(party, event);
                  }}
                >
                  <span className={"wb-live-dot" + (party.runningCount > 0 ? " is-live" : "")} />
                  <span className="wb-party-name">{party.name}</span>
                  <span className="wb-mono wb-party-sub">{partySummaryLine(party, now)}</span>
                </button>
              ))}
              {/* An empty group says so rather than collapsing to a blank strip:
                  a folder you cannot see is a folder you will not file into. */}
              {parties.length === 0 && <p className="wb-group-empty"><LocalizedText id="STR-3769" /></p>}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
