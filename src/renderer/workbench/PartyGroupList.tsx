import { useState } from "react";
import { ChevronDown, Folder, FolderOpen, FolderPlus } from "lucide-react";
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
  onCreateGroup: () => void;
  /** Marks the party row the context menu is currently open on. */
  menuPartyId?: string;
  /** Marks the group the context menu is currently open on. */
  menuGroupId?: string;
}

export function PartyGroupList({
  groups, activePartyId, openGroupIds, now, onToggleGroup, onSelectParty,
  onPartyContextMenu, onGroupContextMenu, onDropParty, onCreateGroup, menuPartyId, menuGroupId,
}: PartyGroupListProps) {
  /** The group under the pointer during a drag, for the drop outline. */
  const [dropGroupId, setDropGroupId] = useState<string | undefined>(undefined);
  /** The party being dragged, so its own group does not offer itself as a target. */
  const [draggingPartyId, setDraggingPartyId] = useState<string | undefined>(undefined);

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

  return (
    <div className="wb-party-list">
      {groups.map(({ group, parties }) => {
        const open = openGroupIds.has(group.id);
        return (
          <div
            key={group.id}
            className={
              "wb-party-group"
              + (open ? " is-open" : "")
              + (dropGroupId === group.id ? " is-drop-target" : "")
              + (group.id === menuGroupId ? " is-menu" : "")
            }
            onDragOver={(event) => {
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
              }
            }}
            onDrop={(event) => {
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
              title={localized("STR-3271")}
              aria-expanded={open}
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
              {group.kind === "default" && <span className="wb-group-badge"><LocalizedText id="STR-3272" /></span>}
              <span className="wb-mono wb-group-count">{parties.length}</span>
            </button>
            <div className="wb-group-parties">
              {parties.map((party) => (
                <button
                  type="button"
                  key={party.id}
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
                  onDragEnd={() => { setDraggingPartyId(undefined); setDropGroupId(undefined); }}
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
              {parties.length === 0 && <p className="wb-group-empty"><LocalizedText id="STR-3375" /></p>}
            </div>
          </div>
        );
      })}
      <button type="button" className="wb-group-add" onClick={onCreateGroup}>
        <FolderPlus size={13} />
        <LocalizedText id="STR-3274" />
      </button>
    </div>
  );
}
