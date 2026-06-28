import { FormEvent, useState } from "react";
import { Check, ChevronsLeft, Plus, Trash2, Users, X } from "lucide-react";
import type { PartyDefinition } from "../../shared/types";
import type { MemberView } from "./types";
import type { RouteLike } from "./routes";
import { memberColorVars } from "../theme/memberColors";
import { statusLabel } from "./memberStatus";
import { MemberWizard } from "./MemberWizard";

export interface CreateMemberInput {
  name: string;
  requirement: string;
  runtime: string;
  model?: string;
  effort?: string;
  reasoning?: string;
  reasoningBudget?: number;
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
  onSelectParty: (partyId: string) => void;
  onCreateParty: (name: string) => void;
  onCreateMember: (input: CreateMemberInput) => void;
  onOpenMember: (member: string) => void;
  onRemoveMember: (member: string) => void;
  onCollapse: () => void;
}

export function PartySidebar(props: PartySidebarProps) {
  const { parties, activePartyId, activePartyName, views, openMembers, workingByParty, memberCountByParty, width, routes, onSelectParty, onCreateParty, onCreateMember, onOpenMember, onRemoveMember, onCollapse } = props;
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  // Two-click confirm: the first trash click arms a member, the second removes it.
  const [armed, setArmed] = useState("");

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
        <button type="button" className="wb-icon-btn" title="파티 패널 접기" onClick={onCollapse}><ChevronsLeft size={16} /></button>
      </header>

      <section className="wb-sidebar-section">
        <div className="wb-section-label">Parties <span className="wb-mono">{parties.length}</span></div>
        <form className="wb-new-party" onSubmit={submit}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="새 파티 이름…" />
          <button type="submit" className="wb-icon-btn is-accent" title="Create party"><Plus size={15} /></button>
        </form>
        <div className="wb-party-list">
          {parties.map((party) => {
            const working = workingByParty[party.id] || 0;
            const count = memberCountByParty[party.id] || 0;
            const active = party.id === activePartyId;
            // Member/working counts are only known for the loaded (active) party;
            // for others we show the name without inventing a count.
            return (
              <button type="button" key={party.id} className={"wb-party-row" + (active ? " is-active" : "")} onClick={() => onSelectParty(party.id)}>
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
          <span>Members</span>
          {!creating && <span className="wb-hint">클릭해 패널로 열기</span>}
          <button type="button" className={"wb-icon-btn wb-section-add" + (creating ? " is-open" : "")} title={creating ? "취소" : "멤버 추가"} onClick={() => setCreating((value) => !value)}>
            {creating ? <X size={14} /> : <Plus size={15} />}
          </button>
        </div>

        {creating && (
          <MemberWizard
            routes={routes}
            onCancel={() => setCreating(false)}
            onCreate={(input) => { onCreateMember(input); setCreating(false); }}
          />
        )}

        <div className="wb-member-list">
          {views.length === 0 && <div className="wb-empty">No members</div>}
          {views.map((view) => {
            const isArmed = armed === view.name;
            const removable = view.name !== "main";
            return (
              <div
                role="button"
                tabIndex={0}
                key={view.name}
                className={"wb-member-row" + (openMembers.has(view.name) ? " is-open" : "")}
                style={memberColorVars(view.name)}
                onClick={() => onOpenMember(view.name)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenMember(view.name); } }}
                onMouseLeave={() => setArmed((current) => (current === view.name ? "" : current))}
              >
                <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
                <span className="wb-member-name">{view.name}</span>
                {view.pendingApproval && <span className="wb-member-badge">승인</span>}
                {!view.pendingApproval && view.unread > 0 && <span className="wb-member-unread">{view.unread}</span>}
                {!view.pendingApproval && view.unread === 0 && <span className="wb-mono wb-member-status">{statusLabel(view.status)}</span>}
                {removable && (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={isArmed ? `${view.name} 영구 삭제 확인` : `${view.name} 삭제`}
                    title={isArmed ? "한 번 더 눌러 영구 삭제" : "멤버 삭제"}
                    className={"wb-member-remove" + (isArmed ? " is-armed" : "")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isArmed) { onRemoveMember(view.name); setArmed(""); }
                      else { setArmed(view.name); }
                    }}
                  >
                    {isArmed ? <Check size={13} /> : <Trash2 size={13} />}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
