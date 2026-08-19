import { FormEvent, useEffect, useState } from "react";
import { Check, ChevronsLeft, ExternalLink, Moon, Pin, Play, Plus, RotateCcw, Sun, Trash2, Users, X } from "lucide-react";
import type { DefaultMemberProfile, HarnessDefaults, PartyDefinition } from "../../shared/types";
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
}

interface PartySidebarProps {
  parties: PartyDefinition[];
  activePartyId?: string;
  activePartyName: string;
  views: MemberView[];
  openMembers: Set<string>;
  workingByParty: Record<string, number>;
  memberCountByParty: Record<string, number>;
  width: number;
  routes: RouteLike[];
  /** Live Codex catalog discovery state, surfaced by the member wizard. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  defaultProfile: DefaultMemberProfile;
  harnessDefaults: Record<string, HarnessDefaults>;
  onSelectParty: (partyId: string) => void;
  onCreateParty: (name: string, gate?: PartyGate) => void;
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
  onCollapse: () => void;
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
function MemberContextMenuItems({ name, view, onRestart, onSetKeepAwake, onSleep, onWake, onRemove, onDone }: {
  name: string;
  view: MemberView | undefined;
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

// Right-click context menu target: a member row, or a party row (which needs a
// confirm step because deleting a party cascades to all of its members).
type CtxMenu =
  | { kind: "member"; name: string; x: number; y: number }
  | { kind: "party"; partyId: string; name: string; x: number; y: number };

export function PartySidebar(props: PartySidebarProps) {
  const { parties, activePartyId, activePartyName, views, openMembers, workingByParty, memberCountByParty, width, routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, onSelectParty, onCreateParty, onCreateMember, onOpenMember, onRestartMember, onRemoveMember, onSetMemberKeepAwake, onSleepMember, onWakeMember, onRemoveParty, onOpenPartyGate, onOpenPartyInNewWindow, onCollapse } = props;
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [newPartyOpen, setNewPartyOpen] = useState(false);
  // Right-click context menu, at the cursor, for a member or party row.
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  // Arms the second, confirming click for the destructive party delete.
  const [confirmParty, setConfirmParty] = useState(false);

  // Dismiss the context menu on any outside click, scroll, or Escape.
  useEffect(() => {
    if (!menu) {
      setConfirmParty(false);
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) {
      return;
    }
    onCreateParty(name);
    setDraft("");
  }

  return (
    <aside className="wb-sidebar" style={{ width }}>
      <header className="wb-sidebar-head">
        <Users size={16} />
        <span className="wb-sidebar-party" title={activePartyName}>{activePartyName}</span>
        <button type="button" className="wb-icon-btn" title={localized("STR-2058")} onClick={onCollapse}><ChevronsLeft size={16} /></button>
      </header>

      <section className="wb-sidebar-section">
        <div className="wb-section-label">Parties <span className="wb-mono">{parties.length}</span></div>
        <form className="wb-new-party" onSubmit={submit}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={localized("STR-2059")} />
          <button type="button" className="wb-icon-btn is-accent" title={localized("STR-2060")} onClick={() => setNewPartyOpen(true)}><Plus size={15} /></button>
        </form>
        <div className="wb-party-list">
          {parties.map((party) => {
            const working = workingByParty[party.id] || 0;
            const count = memberCountByParty[party.id] || 0;
            const active = party.id === activePartyId;
            // Member/working counts are only known for the loaded (active) party;
            // for others we show the name without inventing a count.
            return (
              <button
                type="button"
                key={party.id}
                className={"wb-party-row" + (active ? " is-active" : "") + (menu?.kind === "party" && menu.partyId === party.id ? " is-menu" : "")}
                onClick={() => onSelectParty(party.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setConfirmParty(false);
                  setMenu({ kind: "party", partyId: party.id, name: party.name, x: event.clientX, y: event.clientY });
                }}
              >
                <span className={"wb-live-dot" + (active && working > 0 ? " is-live" : "")} />
                <span className="wb-party-name">{party.name}</span>
                {active && <span className="wb-mono wb-party-sub">{count} members · {working} working</span>}
                {active && <Check size={14} className="wb-party-check" />}
              </button>
            );
          })}
        </div>
      </section>

      <section className="wb-sidebar-section wb-members-section">
        <div className="wb-section-label">
          <span><LocalizedText id="STR-2061" /></span>
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

      {menu && (
        // Fixed to the viewport at the cursor; click handlers above close it.
        <div className="wb-ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
          {menu.kind === "member" ? (
            <MemberContextMenuItems
              name={menu.name}
              view={memberOf(views, menu.name)}
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

      {newPartyOpen && (
        <NewPartyModal
          initialName={draft}
          onCancel={() => setNewPartyOpen(false)}
          onCreate={(name, gate) => { onCreateParty(name, gate); setDraft(""); setNewPartyOpen(false); }}
        />
      )}
    </aside>
  );
}

/**
 * New-party creation modal (opened by the accent +). Name + an optional Message
 * Gate that is OFF by default — you can just enter a name and create. Closes ONLY
 * via Cancel — never an outside click.
 */
function NewPartyModal({ initialName, onCancel, onCreate }: { initialName: string; onCancel: () => void; onCreate: (name: string, gate?: PartyGate) => void }) {
  const [name, setName] = useState(initialName);
  const [gateOn, setGateOn] = useState(false);
  const [rule, setRule] = useState("간결하게 보내세요. 오케스트레이터를 거치지 말고 담당 멤버에게 직접 소통하세요.");
  const canCreate = name.trim().length > 0;

  function create() {
    if (!canCreate) {
      return;
    }
    onCreate(name.trim(), gateOn ? { enabled: true, rule } : undefined);
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
