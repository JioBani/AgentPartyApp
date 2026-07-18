import { FormEvent, useEffect, useState } from "react";
import { Check, ChevronsLeft, Plus, RotateCcw, Trash2, Users, X } from "lucide-react";
import type { DefaultMemberProfile, HarnessDefaults, PartyDefinition } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
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
  /** Live Codex catalog discovery state, surfaced by the member wizard. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  defaultProfile: DefaultMemberProfile;
  harnessDefaults: Record<string, HarnessDefaults>;
  onSelectParty: (partyId: string) => void;
  onCreateParty: (name: string) => void;
  onCreateMember: (input: CreateMemberInput) => void;
  onOpenMember: (member: string) => void;
  /** Hard restart (in-place harness restart); enabled only with a live session. */
  onRestartMember: (member: string) => void;
  onRemoveMember: (member: string) => void;
  onRemoveParty: (partyId: string) => void;
  onCollapse: () => void;
}

// Right-click context menu target: a member row, or a party row (which needs a
// confirm step because deleting a party cascades to all of its members).
type CtxMenu =
  | { kind: "member"; name: string; x: number; y: number }
  | { kind: "party"; partyId: string; name: string; x: number; y: number };

export function PartySidebar(props: PartySidebarProps) {
  const { parties, activePartyId, activePartyName, views, openMembers, workingByParty, memberCountByParty, width, routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, onSelectParty, onCreateParty, onCreateMember, onOpenMember, onRestartMember, onRemoveMember, onRemoveParty, onCollapse } = props;
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
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
          <span>Members</span>
          {!creating && <span className="wb-hint">클릭해 패널로 열기</span>}
          <button type="button" className={"wb-icon-btn wb-section-add" + (creating ? " is-open" : "")} title={creating ? "취소" : "멤버 추가"} onClick={() => setCreating((value) => !value)}>
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
          {views.length === 0 && <div className="wb-empty">No members</div>}
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
                  // Menu is worth showing if anything is actionable: hard restart
                  // (needs a live session) or delete (removable). 'main' with no
                  // session has neither → no menu.
                  if (!removable && !view.session) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu({ kind: "member", name: view.name, x: event.clientX, y: event.clientY });
                }}
              >
                <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
                <span className="wb-member-name">{view.name}</span>
                {view.pendingApproval && <span className="wb-member-badge">승인</span>}
                {view.unread > 0 && <span className="wb-mono wb-member-unread">{view.unread}</span>}
                {!view.pendingApproval && <span className="wb-mono wb-member-status">{statusLabel(view.status)}</span>}
              </div>
            );
          })}
        </div>
      </section>

      {menu && (
        // Fixed to the viewport at the cursor; click handlers above close it.
        <div className="wb-ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
          {menu.kind === "member" ? (
            <>
              <button
                type="button"
                className="wb-ctx-item"
                disabled={!views.find((v) => v.name === menu.name)?.session}
                title="하네스를 그 자리에서 재시작합니다(대화 맥락 초기화, 세션 유지)"
                onClick={() => { onRestartMember(menu.name); setMenu(null); }}
              >
                <RotateCcw size={13} /> 하드 리스타트
              </button>
              {menu.name !== "main" && (
                <button
                  type="button"
                  className="wb-ctx-item is-danger"
                  onClick={() => { onRemoveMember(menu.name); setMenu(null); }}
                >
                  <Trash2 size={13} /> 삭제하기
                </button>
              )}
            </>
          ) : confirmParty ? (
            <button
              type="button"
              className="wb-ctx-item is-danger"
              onClick={() => { onRemoveParty(menu.partyId); setMenu(null); }}
            >
              <Trash2 size={13} /> 파티와 모든 멤버 삭제 · 한 번 더 클릭
            </button>
          ) : (
            <button
              type="button"
              className="wb-ctx-item is-danger"
              onClick={() => setConfirmParty(true)}
            >
              <Trash2 size={13} /> 파티 삭제…
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
