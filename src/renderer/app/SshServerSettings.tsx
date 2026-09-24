import { Copy, FileKey, FlaskConical, Lock, Plus, Server, ShieldAlert, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import type { SshServerView } from "../../shared/sshServers";
import { relativeDay } from "../../shared/relativeTime";
import { SshConnectionStatus } from "../workbench/SshStatus";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Settings → SSH 서버 (S1).
 *
 * Presentational: the server list and every action are props, so the studio and
 * the automation API can show an auth failure or a changed fingerprint without a
 * live server. Layout follows `SshSettingsMockup.tsx` class for class; the rules
 * live in `styles.css` under "SSH 멤버 (1단계)".
 */

export interface SshServerSettingsProps {
  servers: SshServerView[];
  /** Frozen "now" for the last-test column, so previews render deterministically. */
  now: number;
  onAdd: () => void;
  onEdit: (server: SshServerView) => void;
  onDelete: (server: SshServerView) => void;
  onTest: (server: SshServerView) => void;
  onSetupAutoLogin: (server: SshServerView) => void;
  onReviewFingerprint: (server: SshServerView) => void;
  onCopyPublicKey: () => void;
}

export function SshServerSettings(props: SshServerSettingsProps) {
  const { servers, onAdd, onCopyPublicKey } = props;
  const empty = servers.length === 0;
  return (
    <section className="set-card" data-layout-card="settings-ssh-servers">
      <div className="set-card-label">
        <LocalizedText id="STR-3929" /><span className="set-card-sub wb-mono">{empty ? "없음" : `${servers.length}개`}</span>
      </div>
      <div className="set-card-body">
        {empty ? (
          <div className="set-ssh-empty">
            <Server size={22} />
            <p><b><LocalizedText id="STR-3930" /></b></p>
            <button type="button" className="set-btn-accent" onClick={onAdd}><Plus size={14} /> <LocalizedText id="STR-3931" /></button>
          </div>
        ) : (
          <>
            <div className="set-ssh-toolbar">
              <button type="button" className="set-btn-accent" onClick={onAdd}><Plus size={14} /> <LocalizedText id="STR-3932" /></button>
              <span className="set-ssh-toolbar-gap" />
              {/* F10 sits above the list: it is needed before any server exists
                  on the other side (sending the key to an administrator). */}
              <button type="button" className="set-btn-soft" onClick={onCopyPublicKey}><Copy size={14} /> <LocalizedText id="STR-3933" /></button>
            </div>
            <div className="set-ssh-list">
              {servers.map((server) => <SshServerItem key={server.name} server={server} {...props} />)}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function authLabel(server: SshServerView) {
  if (server.auth === "auto") return <><ShieldCheck size={12} /> <LocalizedText id="STR-3934" /></>;
  if (server.auth === "password") return <><Lock size={12} /> <LocalizedText id="STR-3935" /></>;
  return <><FileKey size={12} /> <LocalizedText id="STR-3936" /> <span className="wb-mono">{server.keyFileName}</span></>;
}

function agentName(id: string): string {
  const harness = id.slice("agent:".length);
  return harness === "claude-code" ? "Claude" : harness === "codex" ? "Codex" : harness === "cursor" ? "Cursor" : harness === "grok" ? "Grok" : harness === "muse" ? "Muse" : harness;
}

function SshServerItem({ server, now, onEdit, onDelete, onTest, onSetupAutoLogin, onReviewFingerprint }: { server: SshServerView } & SshServerSettingsProps) {
  const authFailed = server.connection === "auth-failed";
  const fingerprint = server.connection === "fingerprint-changed";
  const target = `${server.user}@${server.host}:${server.port}`;
  const agents = server.lastTest?.items.filter((item) => item.id.startsWith("agent:")) ?? [];
  return (
    <div className={"set-ssh-row" + (authFailed || fingerprint ? " is-alert" : "") + (fingerprint ? " is-danger" : "")} data-ssh-server={server.name}>
      <div className="set-ssh-row-main">
        <span className="set-ssh-icon"><Server size={15} /></span>
        <span className="set-ssh-ident">
          <strong className="set-ssh-name" title={server.name}>{server.name}</strong>
          <span className="wb-mono set-ssh-target" title={target}>{target}</span>
        </span>
        <SshConnectionStatus state={server.connection} />
      </div>

      <div className="set-ssh-row-meta">
        <span className="set-ssh-auth">{authLabel(server)}</span>
        <span><LocalizedText id="STR-3937" /> {server.memberNames.length}명</span>
        {server.lastTest ? (
          <span className="set-ssh-test">
            <LocalizedText id="STR-3938" /> {relativeDay(server.lastTest.at, now)} ·
            {agents.map((agent) => (
              <span key={agent.id} className={"set-ssh-agent is-" + (agent.installed ? "ok" : "fail")} title={agent.installed ? localized("STR-3940") : localized("STR-3939")}>
                {agentName(agent.id)} {agent.installed ? "✓" : "✕"}
              </span>
            ))}
          </span>
        ) : <span><LocalizedText id="STR-3941" /></span>}
      </div>

      {authFailed && (
        <div className="set-ssh-alert">
          <TriangleAlert size={13} />
          <span><b>{server.name}</b> <LocalizedText id="STR-3942" /></span>
        </div>
      )}
      {fingerprint && (
        <div className="set-ssh-alert is-danger">
          <ShieldAlert size={13} />
          <span><LocalizedText id="STR-3943" /></span>
        </div>
      )}

      <div className="set-ssh-actions">
        {fingerprint ? (
          <button type="button" className="set-btn-soft set-ssh-btn-danger" onClick={() => onReviewFingerprint(server)}><ShieldAlert size={14} /> <LocalizedText id="STR-3944" /></button>
        ) : (
          <button type="button" className="set-btn-soft" disabled={server.connection === "connecting"} onClick={() => onTest(server)}><FlaskConical size={14} /> <LocalizedText id="STR-3945" /></button>
        )}
        {server.auth === "password" && !authFailed && !fingerprint && (
          <button type="button" className="set-btn-soft" onClick={() => onSetupAutoLogin(server)}><ShieldCheck size={14} /> <LocalizedText id="STR-3946" /></button>
        )}
        <button type="button" className="set-btn-soft" onClick={() => onEdit(server)}>{authFailed ? "서버 설정 열기" : "수정"}</button>
        <button type="button" className="set-btn-soft set-ssh-icon-btn" title={localized("STR-3950")} aria-label={localized("STR-3949", [server.name])} onClick={() => onDelete(server)}><Trash2 size={14} /></button>
      </div>
    </div>
  );
}
