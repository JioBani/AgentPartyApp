import { ChevronDown, Folder, FolderPlus } from "lucide-react";
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
 */
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
  onCreateGroup: () => void;
  /** Marks the party row the context menu is currently open on. */
  menuPartyId?: string;
}

export function PartyGroupList({
  groups, activePartyId, openGroupIds, now, onToggleGroup, onSelectParty, onPartyContextMenu, onCreateGroup, menuPartyId,
}: PartyGroupListProps) {
  return (
    <div className="wb-party-list">
      {groups.map(({ group, parties }) => {
        const open = openGroupIds.has(group.id);
        return (
          <div key={group.id} className={"wb-party-group" + (open ? " is-open" : "")}>
            <button
              type="button"
              className="wb-group-row"
              title={localized("STR-3271")}
              aria-expanded={open}
              onClick={() => onToggleGroup(group.id)}
            >
              <ChevronDown size={12} className="wb-group-caret" />
              <Folder size={13} />
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
                  }
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
