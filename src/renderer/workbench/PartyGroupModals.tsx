import { useState } from "react";
import { Folder, FolderInput, FolderPlus, PencilLine, X } from "lucide-react";
import type { PartyGroup, PartySummary } from "../../shared/partyGroups";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { useModalEscape } from "./useModalEscape";

/**
 * The two dialogs that manage party groups: create one, and move a party.
 *
 * All three close through Cancel or Escape — never an outside click — like
 * every other modal in this app, so a half-typed group name cannot be lost by
 * clicking the sidebar behind it, while the key that means "back out of this"
 * everywhere else still works here.
 *
 * Markup mirrors the claude.ai/design mockup (`workbench.html`
 * `#overlay-new-group`, `#overlay-move-group`): the move list deliberately
 * reuses `.wb-cwd-list` / `.wb-cwd-item`, because "pick one row out of a short
 * boxed list" is the same control in both places and a second set of classes
 * would be a second thing to restyle.
 */

export function NewGroupModal({ onCancel, onCreate }: {
  onCancel: () => void;
  onCreate: (name: string) => void;
}) {
  useModalEscape(onCancel);
  const [name, setName] = useState("");
  const trimmed = name.trim();

  function create() {
    if (trimmed) {
      onCreate(trimmed);
    }
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-new-party-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <FolderPlus size={16} />
            <strong><LocalizedText id="STR-3669" /></strong>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-3670")} onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-modal-label"><LocalizedText id="STR-3671" /></div>
          <input
            className="wb-gate-name-input"
            value={name}
            autoFocus
            placeholder={localized("STR-3672")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") create(); }}
          />
          <p className="wb-wizard-hint"><LocalizedText id="STR-3673" /></p>
        </div>
        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-3674" /></button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!trimmed} onClick={create}><LocalizedText id="STR-3675" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * Renames a group.
 *
 * Its own dialog rather than an inline-editable row: the name has to be
 * validated against the other groups (duplicates are refused by the store), and
 * a failure needs somewhere to be shown that is not the sidebar.
 */
export function RenameGroupModal({ group, onCancel, onRename }: {
  group: { id: string; name: string };
  onCancel: () => void;
  onRename: (name: string) => void;
}) {
  useModalEscape(onCancel);
  const [name, setName] = useState(group.name);
  const trimmed = name.trim();

  function rename() {
    if (trimmed && trimmed !== group.name) {
      onRename(trimmed);
    }
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-new-party-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <PencilLine size={16} />
            <strong><LocalizedText id="STR-3770" /></strong>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-3771")} onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-modal-label"><LocalizedText id="STR-3671" /></div>
          <input
            className="wb-gate-name-input"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") rename(); }}
          />
          <p className="wb-wizard-hint"><LocalizedText id="STR-3772" /></p>
        </div>
        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-3773" /></button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!trimmed || trimmed === group.name} onClick={rename}><LocalizedText id="STR-3774" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function MoveGroupModal({ party, groups, partyCountByGroup, onCancel, onMove }: {
  party: Pick<PartySummary, "id" | "name" | "groupId">;
  groups: PartyGroup[];
  /** How many parties each group holds, for the right-hand count. */
  partyCountByGroup: Record<string, number>;
  onCancel: () => void;
  onMove: (groupId: string) => void;
}) {
  useModalEscape(onCancel);
  const [target, setTarget] = useState(party.groupId);

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-new-party-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <FolderInput size={16} />
            <strong><LocalizedText id="STR-3676" /> <span className="wb-mono">{party.name}</span></strong>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-3677")} onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-modal-label"><LocalizedText id="STR-3678" /></div>
          <div className="wb-cwd-list">
            {groups.map((group) => (
              <button
                type="button"
                key={group.id}
                className={"wb-cwd-item" + (group.id === target ? " is-selected" : "")}
                aria-current={group.id === target || undefined}
                onClick={() => setTarget(group.id)}
              >
                <Folder size={13} />
                <span className="wb-cwd-item-path">{group.name}</span>
                {group.kind === "default" && <span className="wb-group-badge"><LocalizedText id="STR-3679" /></span>}
                <span className="set-cwd-meta"><LocalizedText id="STR-3681" /> {partyCountByGroup[group.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <p className="wb-wizard-hint"><LocalizedText id="STR-3682" /></p>
        </div>
        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-3683" /></button>
            <button
              type="button"
              className="wb-btn wb-btn-accent"
              disabled={target === party.groupId}
              onClick={() => onMove(target)}
            >
              <LocalizedText id="STR-3684" />
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
