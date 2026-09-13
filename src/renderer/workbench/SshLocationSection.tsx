import { useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Plus, RefreshCw, Server, ShieldAlert, TriangleAlert, WifiOff } from "lucide-react";
import type { MemberExecutionLocation, RecentCwd } from "../../shared/memberLocation";
import { RECENT_CWD_LIMIT, memberLocationsEqual } from "../../shared/memberLocation";
import type { SshRemotePathCheck, SshServerView } from "../../shared/sshServers";
import { relativeDay } from "../../shared/relativeTime";
import { SshConnectionStatus } from "./SshStatus";
import { FloatingMenu } from "./FloatingMenu";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The SSH tab of the member location picker (S6): server, then path.
 *
 * WSL is distro-then-path; SSH is server-then-path, for the same reason — a path
 * means nothing until we know whose filesystem it names. Unlike WSL there is no
 * folder dialog for a remote machine, so the path is typed and checked on the
 * server as soon as it changes.
 *
 * Every server stays selectable, including one whose fingerprint changed
 * (§13 동작 결정 2): the failure is shown when the connection is attempted, never
 * by hiding a server a false alarm would otherwise lock the user out of.
 *
 * Layout follows `SshMemberMockup.tsx` `SshLocationPicker` class for class.
 */

export interface SshBrowsing {
  /** Registered servers; `undefined` while the list is still being read. */
  servers?: SshServerView[];
  /** Result for the CURRENT value; `"checking"` while the server is asked. */
  pathCheck?: "checking" | SshRemotePathCheck;
  onAddServer: () => void;
  onReconnect: (server: string) => void;
  onReviewFingerprint: (server: string) => void;
}

const PATH_PROBLEM_TEXT: Record<Extract<SshRemotePathCheck, { ok: false }>["problem"], string> = {
  "missing": "폴더 없음",
  "not-absolute": "절대 경로 아님",
  "unreachable": "서버에 연결할 수 없음",
  "auth-failed": "서버에 연결할 수 없음",
  "fingerprint-changed": "서버에 연결할 수 없음",
  "server-missing": "서버 없음",
};

export function SshLocationSection({ value, recent, now, ssh, onChange }: {
  value?: MemberExecutionLocation;
  /** `CwdPreferences.sshRecent`, every server; filtered here. */
  recent: RecentCwd[];
  now: number;
  ssh: SshBrowsing;
  onChange: (value: MemberExecutionLocation) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const selectRef = useRef<HTMLButtonElement>(null);
  const servers = ssh.servers;
  const selected = servers?.find((server) => server.name === value?.server);
  const serverRecent = recent.filter((entry) => entry.location.server === value?.server).slice(0, RECENT_CWD_LIMIT);

  if (servers && servers.length === 0) {
    return (
      <div className="wb-ssh-picker-empty" data-ssh-picker="empty">
        <Server size={20} />
        <p><b><LocalizedText id="STR-4025" /></b></p>
        {/* §12-2: a modal over the wizard, so name / role / model stay typed. */}
        <button type="button" className="wb-cwd-browse" onClick={ssh.onAddServer}><Plus size={13} /> <LocalizedText id="STR-4026" /></button>
      </div>
    );
  }

  /**
   * Switching server re-seeds the path from THAT server's most recent one, or
   * clears it: a path carried over from another machine is a directory the user
   * never chose on this one.
   */
  function chooseServer(name: string) {
    setMenuOpen(false);
    if (name === value?.server) return;
    const seed = recent.find((entry) => entry.location.server === name && !entry.problem);
    onChange(seed ? seed.location : { env: "ssh", server: name, cwd: "" });
  }

  const check = value?.cwd ? ssh.pathCheck : undefined;
  const failed = check && check !== "checking" && !check.ok ? check.problem : undefined;
  const unreachable = failed === "unreachable" || failed === "auth-failed" || failed === "fingerprint-changed";

  return (
    <>
      <div className="wb-cwd-distros wb-ssh-server-pick">
        <span className="wb-cwd-distros-label"><LocalizedText id="STR-4027" /></span>
        <button
          ref={selectRef}
          type="button"
          className="wb-ssh-server-select"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          disabled={servers === undefined}
          onClick={() => setMenuOpen((open) => !open)}
          data-ssh-server-select
        >
          <Server size={13} />
          <span className="wb-ssh-server-name" title={selected?.name}>
            {servers === undefined ? "서버 목록 읽는 중" : selected?.name ?? "서버 선택"}
          </span>
          {selected && <SshConnectionStatus state={selected.connection} />}
          <ChevronDown size={13} className="wb-ssh-select-chevron" />
        </button>
        {menuOpen && servers && (
          // Floated under body: the wizard body scrolls and clipped an in-flow menu to two rows.
          // FloatingMenu also owns outside-click and Escape (consumed before the wizard sees it).
          <FloatingMenu anchor={selectRef.current} className="wb-ssh-server-menu" role="listbox" ariaLabel="SSH 서버" matchAnchorWidth onDismiss={() => setMenuOpen(false)}>
            {servers.map((server) => {
              const isSelected = server.name === value?.server;
              return (
                <button
                  key={server.name}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={"wb-ssh-server-option" + (isSelected ? " is-selected" : "") + (server.connection === "fingerprint-changed" ? " is-blocked" : "")}
                  onClick={() => chooseServer(server.name)}
                  data-ssh-server-option={server.name}
                >
                  <span className="wb-cwd-choice" aria-hidden="true">{isSelected && <Check size={11} strokeWidth={3} />}</span>
                  <span className="wb-ssh-server-option-text">
                    <span className="wb-ssh-server-name" title={server.name}>{server.name}</span>
                    <span className="wb-mono wb-ssh-server-target">{server.user}@{server.host}</span>
                  </span>
                  <SshConnectionStatus state={server.connection} />
                </button>
              );
            })}
            <div className="wb-ssh-server-menu-foot">
              <button type="button" className="set-link-btn" onClick={() => { setMenuOpen(false); ssh.onAddServer(); }}><Plus size={12} /> <LocalizedText id="STR-4031" /></button>
            </div>
          </FloatingMenu>
        )}
      </div>

      {unreachable && value?.server && (
        <div className="wb-ssh-callout is-fail">
          {failed === "fingerprint-changed" ? <ShieldAlert size={14} /> : <WifiOff size={14} />}
          <span className="wb-ssh-callout-text"><b>{value.server}</b> <LocalizedText id="STR-4032" /></span>
          {failed === "fingerprint-changed" ? (
            <button type="button" className="set-btn-soft" onClick={() => ssh.onReviewFingerprint(value.server!)}><ShieldAlert size={14} /> <LocalizedText id="STR-4033" /></button>
          ) : (
            <button type="button" className="set-btn-soft" onClick={() => ssh.onReconnect(value.server!)}><RefreshCw size={14} /> <LocalizedText id="STR-4034" /></button>
          )}
        </div>
      )}

      <div className={"wb-cwd-field wb-ssh-path" + (failed ? " is-error" : "")}>
        <Server size={13} />
        {value?.server && <span className="wb-cwd-distro" title={value.server}>{value.server}</span>}
        <input
          className="wb-mono wb-ssh-path-input"
          value={value?.cwd ?? ""}
          placeholder={localized("STR-4035")}
          aria-label={localized("STR-4036")}
          disabled={!value?.server}
          onChange={(event) => value?.server && onChange({ env: "ssh", server: value.server, cwd: event.target.value })}
          data-ssh-path-input
        />
      </div>
      {check && (
        <span className={"wb-ssh-path-check is-" + (check === "checking" ? "busy" : check.ok ? "ok" : "fail")} data-ssh-path-check>
          {check === "checking" ? <LoaderCircle size={12} className="wb-spin" /> : check.ok ? <Check size={12} strokeWidth={3} /> : <TriangleAlert size={12} />}
          {check === "checking" ? "확인 중" : check.ok ? "사용 가능" : PATH_PROBLEM_TEXT[check.problem]}
        </span>
      )}

      {value?.server && serverRecent.length > 0 && (
        <div className="wb-cwd-list">
          <div className="wb-cwd-list-label"><LocalizedText id="STR-4040" /> {value.server} <LocalizedText id="STR-4039" /><span><LocalizedText id="STR-4041" /> {RECENT_CWD_LIMIT}개</span></div>
          <div role="radiogroup" aria-label={localized("STR-4042")}>
            {serverRecent.map((entry) => {
              const isSelected = Boolean(value && memberLocationsEqual(value, entry.location));
              return (
                <button
                  key={entry.location.cwd}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={"wb-cwd-item" + (isSelected ? " is-selected" : "") + (entry.problem ? " is-broken" : "")}
                  onClick={() => onChange(entry.location)}
                >
                  <span className="wb-cwd-choice" aria-hidden="true">{isSelected && <Check size={11} strokeWidth={3} />}</span>
                  <span className="wb-mono wb-cwd-item-path" title={entry.location.cwd}>{entry.location.cwd}</span>
                  {entry.problem
                    ? <span className="wb-cwd-warn"><TriangleAlert size={12} />{entry.problem.message}</span>
                    : <span className="set-cwd-meta">{relativeDay(entry.usedAt, now)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
