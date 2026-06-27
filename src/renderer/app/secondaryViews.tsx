import type { FormEvent } from "react";
import { Check, Copy, KeyRound, RefreshCw, Send, ShieldCheck, Trash2, UsersRound, X } from "lucide-react";
import type { InitialAppState, PartyMember, SessionView } from "../../shared/types";
import { RouteLike, routeKey } from "../workbench/routes";

const permissionModes = [
  { id: "default", label: "기본" },
  { id: "acceptEdits", label: "수정 허용" },
  { id: "plan", label: "계획" },
  { id: "auto", label: "자동" },
  { id: "dontAsk", label: "묻지 않음" },
  { id: "bypassPermissions", label: "권한 확인 생략" },
];

export function SessionsView({ sessions, resumable, resumableError, onOpen, onClose, onRefresh, onResume }: {
  sessions: SessionView[];
  resumable: NonNullable<InitialAppState["resumableSessions"]>;
  resumableError?: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onRefresh: () => void;
  onResume: (id: string) => void;
}) {
  return (
    <section className="legacy-view">
      <div className="view-toolbar"><button className="ghost-btn" onClick={onRefresh}><RefreshCw size={15} /> 기록 새로고침</button></div>
      <div className="split-grid">
        <section className="card">
          <div className="card-title">활성 세션</div>
          <div className="row-list">
            {sessions.length === 0 && <div className="empty">활성 세션이 없습니다</div>}
            {sessions.map((session) => (
              <button key={session.id} className="list-row" onClick={() => onOpen(session.id)}>
                <span><strong>{session.title || "Claude Code"}</strong><small>{session.snapshot.status || "idle"}</small></span>
                <button type="button" className="row-x" title="닫기" onClick={(event) => { event.stopPropagation(); onClose(session.id); }}><X size={13} /></button>
              </button>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-title">이전 세션</div>
          <div className="row-list">
            {resumableError && <div className="soft-error">{resumableError}</div>}
            {!resumableError && resumable.length === 0 && <div className="empty">이어갈 수 있는 세션이 없습니다</div>}
            {resumable.map((session) => (
              <button className="list-row" key={session.sessionId} onClick={() => onResume(session.sessionId)}>
                <span><strong>{session.customTitle || session.summary || session.firstPrompt || session.sessionId}</strong><small>{[session.lastModified ? new Date(session.lastModified).toLocaleString() : "", session.gitBranch].filter(Boolean).join(" - ")}</small></span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

export function PartyAdminView(props: {
  parties: InitialAppState["party"]["parties"];
  selectedParty?: { id: string; name: string };
  members: PartyMember[];
  messages: NonNullable<InitialAppState["party"]["messages"]>;
  partyError?: string;
  partyNameDraft: string;
  partyDraft: { name: string; requirement: string; initialTask: string; runtime: string };
  memberMessages: Record<string, string>;
  removeConfirm: string;
  partyNotice: string;
  hasActiveSession: boolean;
  onPartyNameDraft: (value: string) => void;
  onCreateParty: () => void;
  onSelectParty: (id: string) => void;
  onPartyDraft: (value: { name: string; requirement: string; initialTask: string; runtime: string }) => void;
  onCreateMember: (event: FormEvent) => void;
  onMemberMessage: (name: string, value: string) => void;
  onSendToMember: (name: string) => void;
  onMemberAction: (action: "close" | "bind" | "remove", name: string) => void;
  onRefresh: () => void;
}) {
  const { selectedParty, members, messages, partyError, partyNameDraft, partyDraft, memberMessages, removeConfirm, partyNotice, hasActiveSession } = props;
  return (
    <section className="legacy-view">
      <div className="view-toolbar"><button className="ghost-btn" onClick={props.onRefresh}><RefreshCw size={15} /> 파티 새로고침</button></div>
      <div className="split-grid">
        <form className="card" onSubmit={(event) => { event.preventDefault(); props.onCreateParty(); }}>
          <div className="card-title">파티 만들기</div>
          <input value={partyNameDraft} onChange={(event) => props.onPartyNameDraft(event.target.value)} placeholder="파티 이름" />
          <button type="submit" className="accent-btn"><UsersRound size={15} /> 파티 만들기</button>
          <div className="chip-list">
            {(props.parties || []).map((party) => (
              <button key={party.id} type="button" className={"chip" + (party.id === selectedParty?.id ? " is-active" : "")} onClick={() => props.onSelectParty(party.id)}>
                <UsersRound size={13} /> {party.name}
              </button>
            ))}
          </div>
        </form>
        <form className="card" onSubmit={props.onCreateMember}>
          <div className="card-title">{selectedParty?.name || "파티"}에 멤버 만들기</div>
          <input value={partyDraft.name} onChange={(event) => props.onPartyDraft({ ...partyDraft, name: event.target.value })} placeholder="멤버 이름" />
          <select value={partyDraft.runtime} onChange={(event) => props.onPartyDraft({ ...partyDraft, runtime: event.target.value })}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select>
          <textarea value={partyDraft.requirement} onChange={(event) => props.onPartyDraft({ ...partyDraft, requirement: event.target.value })} placeholder="역할과 책임" />
          <textarea value={partyDraft.initialTask} onChange={(event) => props.onPartyDraft({ ...partyDraft, initialTask: event.target.value })} placeholder="선택 사항: 첫 작업 메모" />
          <button type="submit" className="accent-btn"><UsersRound size={15} /> 만들기</button>
          {partyNotice && <div className="notice">{partyNotice}</div>}
        </form>
        <section className="card">
          <div className="card-title">멤버</div>
          <div className="row-list">
            {partyError && <div className="soft-error">{partyError}</div>}
            {!partyError && members.length === 0 && <div className="empty">아직 파티 멤버가 없습니다</div>}
            {members.map((member) => (
              <div className="member-admin" key={member.name}>
                <div className="member-admin-head"><strong>{member.name}</strong><small>{memberSummary(member)}</small></div>
                <div className="member-admin-role">{member.role}</div>
                <div className="member-admin-actions">
                  <button type="button" className="micro" disabled={!hasActiveSession} onClick={() => props.onMemberAction("bind", member.name)}>활성 세션 연결</button>
                  <button type="button" className="micro" onClick={() => props.onMemberAction("close", member.name)}>닫기</button>
                  <button type="button" className={"micro danger" + (removeConfirm === member.name ? " armed" : "")} disabled={member.name === "main"} onClick={() => props.onMemberAction("remove", member.name)}><Trash2 size={12} /> 삭제</button>
                </div>
                <div className="member-admin-send">
                  <input value={memberMessages[member.name] || ""} onChange={(event) => props.onMemberMessage(member.name, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") props.onSendToMember(member.name); }} placeholder={`${member.name}에게 메시지`} />
                  <button type="button" className="micro" onClick={() => props.onSendToMember(member.name)}><Send size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-title">최근 파티 메시지</div>
          <div className="row-list">
            {messages.length === 0 && <div className="empty">아직 파티 메시지가 없습니다</div>}
            {messages.slice(-12).reverse().map((message) => (
              <div className="party-msg" key={message.id}>
                <div className="party-msg-head"><strong>{message.from}</strong><span>→</span><strong>{message.to}</strong><span className={"tag " + (message.delivered ? "ok" : "warn")}>{message.delivered ? "전달됨" : "대기 중"}</span></div>
                <p>{message.content}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

export function AuthView({ auth, draft, onDraft, onSave, onTest }: {
  auth: InitialAppState["auth"];
  draft: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <section className="legacy-view narrow">
      <section className="card">
        <div className="card-title">인증</div>
        {auth.map((provider) => (
          <div className="auth-row" key={provider.id}>
            <div className="auth-icon">{provider.kind === "apiKey" ? <KeyRound size={16} /> : <ShieldCheck size={16} />}</div>
            <div className="auth-body"><strong>{provider.label}</strong><small>{provider.detail || provider.description}</small>{provider.maskedValue && <code>{provider.maskedValue}</code>}</div>
            <span className={"tag " + provider.status}>{provider.status}</span>
          </div>
        ))}
        <div className="key-box">
          <input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="OpenRouter API 키" type="password" />
          <button onClick={onSave} type="button" className="accent-btn"><Check size={15} /></button>
          <button className="ghost-btn" type="button" onClick={onTest}>테스트</button>
        </div>
      </section>
    </section>
  );
}

export function RuntimeSettingsView({ routes, harnesses, draft, router, settings, onDraft, onApply, onToggleDebug }: {
  routes: RouteLike[];
  harnesses: any[];
  draft: { routeKey: string; effort: string; permissionMode: string };
  router: string;
  settings: InitialAppState["settings"];
  onDraft: (value: { routeKey: string; effort: string; permissionMode: string }) => void;
  onApply: () => void;
  onToggleDebug: (enabled: boolean) => void;
}) {
  return (
    <section className="legacy-view">
      <div className="split-grid">
        <section className="card">
          <div className="card-title">기본 런타임</div>
          <Info label="Router" value={router} />
          <Info label="Harness" value={settings.selectedHarnessId} />
          <Info label="Provider" value={settings.selectedProviderId} />
          <div className="notice">이 기본값은 새 멤버 세션을 시작할 때 사용됩니다.</div>
          <label className="field">모델<select value={draft.routeKey} onChange={(event) => onDraft({ ...draft, routeKey: event.target.value })}>{routes.map((route) => <option key={routeKey(route)} value={routeKey(route)} disabled={route.enabled === false}>{(route.label || route.model) + " - " + (route.providerId || "anthropic")}</option>)}</select></label>
          <label className="field">추론 강도<select value={draft.effort} onChange={(event) => onDraft({ ...draft, effort: event.target.value })}>{["low", "medium", "high", "xhigh", "max"].map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
          <label className="field">권한 모드<select value={draft.permissionMode} onChange={(event) => onDraft({ ...draft, permissionMode: event.target.value })}>{permissionModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
          <div className="field-actions"><button type="button" className="accent-btn" onClick={onApply}>기본값 적용</button></div>
          <label className="toggle-line"><input type="checkbox" checked={settings.debugEnabled} onChange={(event) => onToggleDebug(event.target.checked)} />디버그 로그</label>
        </section>
        <section className="card">
          <div className="card-title">모델 라우트</div>
          <div className="row-list">{routes.map((route) => <div className="info-line" key={routeKey(route)}><span>{route.label || route.model}</span><small>{route.providerId} - {route.harnessId}</small></div>)}</div>
        </section>
        <section className="card">
          <div className="card-title">하네스</div>
          <div className="row-list">{harnesses.map((harness) => <div className="info-line" key={harness.id}><span>{harness.label}</span><small>{harness.status} - {harness.description}</small></div>)}</div>
        </section>
      </div>
    </section>
  );
}

export function AutomationView({ automationApi, logs, debugEnabled, onToggleDebug }: {
  automationApi: InitialAppState["automationApi"];
  logs: InitialAppState["logs"];
  debugEnabled: boolean;
  onToggleDebug: (enabled: boolean) => void;
}) {
  return (
    <section className="legacy-view narrow">
      <section className="card">
        <div className="card-title">자동화 API</div>
        <Info label="API" value={automationApi?.baseUrl || ""} />
        <Info label="Spec" value={automationApi?.spec || ""} />
        <Info label="Logs" value={logs?.logFilePath || ""} />
        <label className="toggle-line"><input type="checkbox" checked={debugEnabled} onChange={(event) => onToggleDebug(event.target.checked)} />디버그 로그</label>
        <button className="ghost-btn" type="button" onClick={() => navigator.clipboard?.writeText(automationApi?.spec || "")}><Copy size={15} /> API 스펙 URL 복사</button>
        <div className="api-hint wb-mono">{automationApi?.spec || "API 시작 중..."}</div>
      </section>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-line"><span>{label}</span><strong className="wb-mono">{value || "없음"}</strong></div>;
}

function memberSummary(member: PartyMember): string {
  return [member.status, member.runtime, member.model, member.sessionId ? `세션 ${member.sessionId}` : ""].filter(Boolean).join(" - ");
}
