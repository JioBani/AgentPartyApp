import { LoaderCircle, Plus, RefreshCw, Server, ShieldAlert, TriangleAlert, WifiOff } from "lucide-react";
import type { SshConnectionState } from "../../shared/sshServers";
import { LocalizedText } from "../i18n/I18nProvider";

/**
 * S8 — what a broken SSH connection looks like around the members that use it.
 *
 * §12-3: the cause is the SERVER, so the drawer says it once per server
 * (`SshServerNotice`), the member row carries only a short chip, and the open
 * member's transcript shows one banner (`SshConnectionBanner`). Two servers down
 * at once are two lines, never a stack of per-member warnings.
 *
 * Wording follows the handoff: which server, what failed, one action. No
 * guessed cause.
 */

export type SshNoticeAction = "reconnect" | "open-settings" | "review-fingerprint";

export type SshNoticeState = Extract<SshConnectionState, "reconnecting" | "unreachable" | "auth-failed" | "fingerprint-changed">;

export function isSshNoticeState(state: SshConnectionState): state is SshNoticeState {
  return state === "reconnecting" || state === "unreachable" || state === "auth-failed" || state === "fingerprint-changed";
}

const NOTICE: Record<SshNoticeState, { tone: "warn" | "fail" | "danger"; text: string; action: SshNoticeAction; actionLabel: string }> = {
  "reconnecting": { tone: "warn", text: "연결 끊김 · 재연결 중", action: "reconnect", actionLabel: "다시 연결" },
  "unreachable": { tone: "fail", text: "연결할 수 없음", action: "reconnect", actionLabel: "다시 연결" },
  "auth-failed": { tone: "fail", text: "로그인 실패", action: "open-settings", actionLabel: "서버 설정 열기" },
  "fingerprint-changed": { tone: "danger", text: "서버 지문 변경 · 연결 차단", action: "review-fingerprint", actionLabel: "지문 확인" },
};

/** The short chip on a member row / panel header while its server is down. */
export const SSH_MEMBER_CHIP: Record<SshNoticeState | "server-missing", { tone: "busy" | "fail"; label: string }> = {
  "reconnecting": { tone: "busy", label: "재연결 중" },
  "unreachable": { tone: "fail", label: "연결할 수 없음" },
  "auth-failed": { tone: "fail", label: "로그인 실패" },
  "fingerprint-changed": { tone: "fail", label: "연결 차단" },
  "server-missing": { tone: "fail", label: "서버 없음" },
};

/** One line per server at the top of the member drawer. */
export function SshServerNotice({ server, state, memberCount, onAction }: {
  server: string;
  state: SshNoticeState;
  memberCount: number;
  onAction: (action: SshNoticeAction, server: string) => void;
}) {
  const notice = NOTICE[state];
  return (
    <div className={"wb-ssh-notice is-" + notice.tone} data-ssh-notice={server}>
      {notice.tone === "danger" ? <ShieldAlert size={14} /> : notice.tone === "fail" ? <TriangleAlert size={14} /> : <WifiOff size={14} />}
      <span className="wb-ssh-notice-text"><b title={server}>{server}</b> {notice.text}</span>
      <span className="wb-ssh-notice-count"><LocalizedText id="STR-4010" /> {memberCount}명</span>
      <button type="button" className="set-btn-soft" onClick={() => onAction(notice.action, server)}>{notice.actionLabel}</button>
    </div>
  );
}

/**
 * `agentStartError`: an agent on the server refused to start (e.g. not logged in).
 * §13-4 — the agent's own message is shown verbatim with server and agent named;
 * the app offers no login flow in phase 1.
 */
export type SshBannerState = SshNoticeState | "server-missing" | { agentStartError: { agent: string; message: string } };

/** The one banner inside an open SSH member's transcript. */
/**
 * A remote agent refused to start (§13-4): which server, which agent, and the
 * agent's own message verbatim. No login flow is offered in phase 1.
 */
export function SshAgentStartError({ server, agent, message }: { server: string; agent: string; message: string }) {
  return (
    <div className="wb-env wb-ssh-banner" data-ssh-banner="agent-start-error">
      <div className="wb-env-head"><TriangleAlert size={14} /><span className="wb-env-title">{server} <LocalizedText id="STR-4012" /> {agent} <LocalizedText id="STR-4011" /></span></div>
      <div className="wb-env-detail"><code className="wb-mono wb-ssh-agent-error">{message}</code></div>
    </div>
  );
}

export function SshConnectionBanner({ server, state, onAction, onRegisterServer }: {
  server: string;
  state: SshBannerState;
  onAction: (action: SshNoticeAction, server: string) => void;
  onRegisterServer: (server: string) => void;
}) {
  if (typeof state === "object") {
    return <SshAgentStartError server={server} agent={state.agentStartError.agent} message={state.agentStartError.message} />;
  }
  if (state === "reconnecting") {
    // Still retrying on its own: warning tone, nothing to press yet.
    return (
      <div className="wb-ssh-banner is-warn" data-ssh-banner={state}>
        <div className="wb-env-head"><LoaderCircle size={14} className="wb-spin" /><span className="wb-env-title">{server} <LocalizedText id="STR-4013" /></span></div>
      </div>
    );
  }
  if (state === "server-missing") {
    return (
      <div className="wb-env wb-ssh-banner" data-ssh-banner={state}>
        <div className="wb-env-head"><Server size={14} /><span className="wb-env-title">{server} <LocalizedText id="STR-4014" /></span></div>
        <div className="wb-env-actions"><button type="button" className="set-btn-accent" onClick={() => onRegisterServer(server)}><Plus size={14} /> {server} <LocalizedText id="STR-4015" /></button></div>
      </div>
    );
  }
  const title = state === "unreachable" ? `${server} 에 연결할 수 없습니다`
    : state === "auth-failed" ? `${server} 에 로그인할 수 없습니다`
    : `${server} 서버 지문이 바뀌어 연결을 막았습니다`;
  const notice = NOTICE[state];
  return (
    <div className={"wb-env wb-ssh-banner" + (state === "fingerprint-changed" ? " is-danger" : "")} data-ssh-banner={state}>
      <div className="wb-env-head">
        {state === "fingerprint-changed" ? <ShieldAlert size={15} /> : state === "unreachable" ? <WifiOff size={14} /> : <TriangleAlert size={14} />}
        <span className="wb-env-title">{title}</span>
      </div>
      <div className="wb-env-actions">
        <button type="button" className="set-btn-accent" onClick={() => onAction(notice.action, server)}>
          {notice.action === "reconnect" && <RefreshCw size={14} />} {notice.actionLabel}
        </button>
      </div>
    </div>
  );
}
