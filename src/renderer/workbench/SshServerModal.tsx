import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, Eye, EyeOff, FileKey, FlaskConical, FolderOpen, KeyRound, LoaderCircle, Lock, RefreshCw, Server, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type {
  SshAttemptErrorKind, SshAutoLoginStep, SshCheckItem, SshConnectAttempt, SshDraftField, SshFieldError, SshKeyInspection, SshServerDraft,
} from "../../shared/sshServers";
import { SshStep, checkTone } from "./SshStatus";
import { useModalEscape } from "./useModalEscape";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Add / edit an SSH server (S2), with the auto-login offer (S4) and the
 * connection test (S5) rendered in the SAME container (§12-4).
 *
 * The form, the connection, the offer, the progress and the test result replace
 * each other in one modal so the member wizard below never gains a third layer.
 * The fingerprint question is the one exception and lives in
 * `SshServerDialogs.tsx`.
 *
 * Presentational: the draft is local, but everything the backend knows — the
 * attempt's phase, the key file inspection, field errors — arrives as props.
 * Layout follows `SshSettingsMockup.tsx` `SshServerForm` class for class.
 */

export interface SshServerModalProps {
  mode: "add" | "edit";
  /** Seed values. Secrets are never seeded; edit shows "변경 시 입력". */
  initial?: Omit<SshServerDraft, "auth"> & { authKind: "password" | "key" | "auto"; keyPath?: string };
  /** The running attempt, once 연결 / 저장 was pressed. */
  attempt?: SshConnectAttempt;
  /** Synchronous validation result of the last submit. */
  fieldErrors?: SshFieldError[];
  keyInspection?: SshKeyInspection;
  /** Submit is being sent (before an attempt exists). */
  submitting?: boolean;
  /** A call to the feature failed outright (not a connection result). */
  error?: string;
  onSubmit: (draft: SshServerDraft) => void;
  /** Edit only: test without saving. */
  onTest?: (draft: SshServerDraft) => void;
  onPickKeyFile: () => void;
  onCancel: () => void;
  onSetupAutoLogin: () => void;
  onContinueWithPassword: () => void;
  onSavePasswordLogin: () => void;
  onRetest: () => void;
  onCopyPublicKey: () => void;
  onDone: () => void;
}

const FIELD_ERROR: Record<SshDraftField, Partial<Record<SshFieldError["kind"], string>>> = {
  name: { required: "서버 이름을 입력하세요", duplicate: "이미 같은 이름의 서버가 있습니다" },
  host: { required: "서버 주소를 입력하세요" },
  // The port column is narrow; the handoff shortens §9's sentence to the range.
  port: { required: "1–65535", "port-range": "1–65535" },
  user: { required: "계정을 입력하세요" },
  password: { required: "비밀번호를 입력하세요" },
  keyPath: { required: "키 파일을 선택하세요" },
};

const KEY_FILE_ERROR: Record<Extract<SshKeyInspection, { error: string }>["error"], string> = {
  "public-key": "공개 키 파일입니다. 개인 키 파일을 선택하세요.",
  "ppk": "PuTTY 형식은 아직 지원하지 않습니다.",
  "not-key": "SSH 개인 키 파일이 아닙니다.",
  "inspect-failed": localized("STR-4205"),
};

const AUTO_LOGIN_STEP_LABEL: Record<SshAutoLoginStep["id"], string> = {
  "key": "보안 키 준비",
  "register": "서버에 등록",
  "verify": "자동 로그인으로 다시 접속 확인",
  "forget-password": "비밀번호 삭제",
};

function fieldError(errors: SshFieldError[] | undefined, field: SshDraftField): string | undefined {
  const error = errors?.find((entry) => entry.field === field);
  return error ? FIELD_ERROR[field][error.kind] ?? FIELD_ERROR[field].required : undefined;
}

function agentLabel(id: string): string {
  const harness = id.slice("agent:".length);
  return harness === "claude-code" ? "Claude Code" : harness === "codex" ? "Codex" : harness === "cursor" ? "Cursor" : harness === "grok" ? "Grok Build" : harness;
}

/** One test line, worded from its kind (§7.4). */
function checkText(item: SshCheckItem, attempt: SshConnectAttempt, authWord: string): string {
  if (item.id === "connect") return item.status === "checking" ? `${attempt.serverName} 에 연결 중` : "서버 연결";
  if (item.id === "login") return item.status === "ok" ? `로그인 (${authWord})` : "로그인";
  const name = agentLabel(item.id);
  if (item.status === "checking") return `${name} 확인 중`;
  if (item.status === "pending") return name;
  if (item.installed === false) return `${name} 설치 안 됨`;
  // §13-4: installation only; login happens on the server, outside the app.
  return `${name} 설치됨`;
}

export function SshServerModal(props: SshServerModalProps) {
  const { mode, initial, attempt, fieldErrors, keyInspection, submitting, onSubmit, onTest, onPickKeyFile, onCancel } = props;
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [user, setUser] = useState(initial?.user ?? "");
  const [authKind, setAuthKind] = useState<"password" | "key" | "auto">(initial?.authKind ?? "password");
  // Auto-login is offered only while editing a server that already has it: the
  // stored app key keeps working until the user deliberately picks another method.
  const canKeepAuto = mode === "edit" && initial?.authKind === "auto";
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const keyPath = initial?.keyPath;
  const editing = mode === "edit";

  const phase = attempt?.phase;
  const connecting = submitting || phase === "connecting" || phase === "fingerprint";
  const afterConnect = phase === "offer-auto-login" || phase === "auto-login" || phase === "auto-login-failed" || phase === "testing" || phase === "done";
  const locked = phase === "auto-login";
  useModalEscape(onCancel, !connecting && !locked);

  const draft = (): SshServerDraft => ({
    originalName: editing ? initial?.name : undefined,
    name: name.trim(),
    host: host.trim(),
    port: Number(port),
    user: user.trim(),
    auth: authKind === "auto"
      ? { kind: "auto" }
      : authKind === "password"
        ? { kind: "password", password: password || undefined }
        : { kind: "key", keyPath: keyPath ?? "", passphrase: passphrase || undefined },
  });

  const keyOk = keyInspection && !("error" in keyInspection) ? keyInspection : undefined;
  const keyError = keyInspection && "error" in keyInspection
    ? `${KEY_FILE_ERROR[keyInspection.error]}${keyInspection.error === "inspect-failed" ? ` · ${keyInspection.detail}` : ""}`
    : undefined;
  const error = phase === "failed" ? attempt?.error : undefined;
  const authWord = authKind === "key" ? "키 파일" : authKind === "auto" || attempt?.autoLoginSteps?.every((step) => step.status === "ok") ? "자동 로그인" : "비밀번호";
  const target = attempt ? `${attempt.serverName} · ${attempt.target.user}@${attempt.target.host}:${attempt.target.port}` : "";

  // Portaled: a settings tab panel is a containing block, which clipped the scrim to its column.
  return createPortal(
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-ssh-modal" role="dialog" aria-modal="true" aria-label={editing ? localized("STR-4093") : localized("STR-4094")} data-ssh-dialog="server">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <Server size={16} className="wb-ssh-accent" />
            <strong>{editing ? "SSH 서버 수정" : "SSH 서버 추가"}</strong>
            {afterConnect && <span className="wb-mono wb-modal-sub">{target}</span>}
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-4097")} disabled={locked || connecting} onClick={onCancel}><X size={16} /></button>
        </header>

        <div className="wb-modal-body wb-ssh-body">
          {props.error && (
            <div className="wb-ssh-callout is-fail" role="alert">
              <TriangleAlert size={14} />
              <span className="wb-ssh-callout-text">{props.error}</span>
            </div>
          )}
          {!afterConnect && (
            <fieldset className="wb-ssh-fields" disabled={connecting}>
              <div className="wb-ssh-grid">
                <Field label={localized("STR-4099")} error={fieldError(fieldErrors, "name")} help={localized("STR-4098")}>
                  <div className="set-input"><input value={name} onChange={(event) => setName(event.target.value)} data-ssh-field="name" /></div>
                </Field>
                <Field label={localized("STR-4100")} error={fieldError(fieldErrors, "host")}>
                  <div className="set-input"><input value={host} placeholder={localized("STR-4101")} onChange={(event) => setHost(event.target.value)} data-ssh-field="host" /></div>
                </Field>
                <Field label={localized("STR-4102")} error={fieldError(fieldErrors, "port")}>
                  <div className="set-input set-ssh-port"><input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} data-ssh-field="port" /></div>
                </Field>
                <Field label={localized("STR-4103")} error={fieldError(fieldErrors, "user")}>
                  <div className="set-input"><input value={user} onChange={(event) => setUser(event.target.value)} data-ssh-field="user" /></div>
                </Field>
              </div>

              <div className="set-field set-ssh-field">
                <span className="set-field-label"><LocalizedText id="STR-4104" /></span>
                <div className="wb-env-seg set-ssh-auth-seg" role="group" aria-label={localized("STR-4105")}>
                  {canKeepAuto && (
                    <button type="button" className={authKind === "auto" ? "is-active" : ""} aria-pressed={authKind === "auto"} onClick={() => setAuthKind("auto")} data-ssh-auth="auto"><ShieldCheck size={13} /> <LocalizedText id="STR-3934" /></button>
                  )}
                  <button type="button" className={authKind === "password" ? "is-active" : ""} aria-pressed={authKind === "password"} onClick={() => setAuthKind("password")}><Lock size={13} /> <LocalizedText id="STR-4106" /></button>
                  <button type="button" className={authKind === "key" ? "is-active" : ""} aria-pressed={authKind === "key"} onClick={() => setAuthKind("key")}><FileKey size={13} /> <LocalizedText id="STR-4107" /></button>
                </div>
              </div>

              {authKind === "password" && (
                <Field label={localized("STR-4108")} error={fieldError(fieldErrors, "password")}>
                  <SecretInput value={password} onChange={setPassword} placeholder={editing ? localized("STR-4109") : localized("STR-4110")} field="password" />
                </Field>
              )}

              {authKind === "key" && (
                <div className={"set-field set-ssh-field" + (keyError || fieldError(fieldErrors, "keyPath") ? " is-error" : "")}>
                  <span className="set-field-label"><LocalizedText id="STR-4111" /></span>
                  <div className="wb-cwd-field">
                    <FileKey size={13} />
                    <span className="wb-mono wb-cwd-path" title={keyPath}>{keyPath || "키 파일을 선택하세요"}</span>
                    <button type="button" className="wb-cwd-browse" onClick={onPickKeyFile}><FolderOpen size={13} /> <LocalizedText id="STR-4113" /></button>
                  </div>
                  {keyError || fieldError(fieldErrors, "keyPath") ? (
                    <span className="set-ssh-field-error"><TriangleAlert size={12} /> {keyError || fieldError(fieldErrors, "keyPath")}</span>
                  ) : keyOk && (
                    <div className="wb-ssh-keyinfo">
                      <span><b>{keyOk.fileName}</b></span>
                      <span className="wb-mono">{keyOk.fingerprint}</span>
                      {keyOk.comment && <span><LocalizedText id="STR-4114" /> {keyOk.comment}</span>}
                    </div>
                  )}
                </div>
              )}

              {authKind === "key" && keyOk?.locked && (
                <Field label={localized("STR-4115")}>
                  <SecretInput value={passphrase} onChange={setPassphrase} placeholder={localized("STR-4116")} field="passphrase" />
                </Field>
              )}

              {error?.kind === "password-not-allowed" && (
                <div className="wb-ssh-callout is-warn">
                  <TriangleAlert size={14} />
                  <span className="wb-ssh-callout-text"><LocalizedText id="STR-4117" /></span>
                  <button type="button" className="set-btn-soft" onClick={() => setAuthKind("key")}><FileKey size={14} /> <LocalizedText id="STR-4118" /></button>
                </div>
              )}
              {error?.kind === "key-rejected" && (
                <div className="wb-ssh-callout is-fail">
                  <TriangleAlert size={14} />
                  <span className="wb-ssh-callout-text">
                    <LocalizedText id="STR-4120" />{error.keyFingerprint && <>(<code className="wb-mono">{shortFingerprint(error.keyFingerprint)}</code>)</>}<LocalizedText id="STR-4119" />
                  </span>
                  <span className="wb-ssh-callout-actions">
                    <button type="button" className="set-btn-soft" onClick={props.onCopyPublicKey}><Copy size={14} /> <LocalizedText id="STR-4121" /></button>
                    <button type="button" className="set-btn-soft" onClick={() => setAuthKind("password")}><Lock size={14} /> <LocalizedText id="STR-4122" /></button>
                  </span>
                </div>
              )}
              {error && error.kind !== "password-not-allowed" && error.kind !== "key-rejected" && (
                <div className="wb-ssh-callout is-fail">
                  <TriangleAlert size={14} />
                  <span className="wb-ssh-callout-text">
                    {attemptErrorText(error.kind, attempt?.serverName || name)}
                    {error.detail && <span className="wb-mono"> · {error.detail}</span>}
                  </span>
                </div>
              )}
            </fieldset>
          )}

          {connecting && attempt && (
            <div className="wb-ssh-card">
              <ul className="wb-ssh-steps">
                {attempt.steps.filter((item) => item.id === "connect" || item.id === "login").map((item) => (
                  <SshStep key={item.id} tone={checkTone(item.status)} text={checkText(item, attempt, authWord)} />
                ))}
              </ul>
            </div>
          )}

          {attempt && phase === "offer-auto-login" && (
            <>
              <div className="wb-ssh-card">
                <ul className="wb-ssh-steps">
                  {attempt.steps.filter((item) => item.id === "connect" || item.id === "login").map((item) => (
                    <SshStep key={item.id} tone={checkTone(item.status)} text={checkText(item, attempt, localized("STR-4123"))} />
                  ))}
                </ul>
              </div>
              <div className="wb-ssh-card is-offer">
                <div className="wb-ssh-card-head">
                  <ShieldCheck size={16} className="wb-ssh-accent" />
                  <strong><LocalizedText id="STR-4124" /></strong>
                </div>
                <p className="wb-ssh-card-note"><LocalizedText id="STR-4125" /></p>
                <div className="wb-ssh-card-actions">
                  <button type="button" className="set-btn-soft" onClick={props.onContinueWithPassword}><LocalizedText id="STR-4126" /></button>
                  <button type="button" className="set-btn-accent" onClick={props.onSetupAutoLogin}><ShieldCheck size={14} /> <LocalizedText id="STR-4127" /></button>
                </div>
              </div>
            </>
          )}

          {attempt && (phase === "auto-login" || phase === "auto-login-failed") && (
            <div className="wb-ssh-card">
              <div className="wb-ssh-card-head">
                <ShieldCheck size={16} className="wb-ssh-accent" />
                <strong><LocalizedText id="STR-4128" /></strong>
              </div>
              <ul className="wb-ssh-steps">
                {(attempt.autoLoginSteps ?? []).map((step) => {
                  const skipped = phase === "auto-login-failed" && step.id === "forget-password" && step.status !== "ok";
                  return (
                    <SshStep
                      key={step.id}
                      tone={skipped ? "idle" : checkTone(step.status)}
                      text={AUTO_LOGIN_STEP_LABEL[step.id] + (skipped ? " " + localized("STR-4129") : "")}
                      fixText={step.status === "fail" ? step.detail : undefined}
                    />
                  );
                })}
              </ul>
            </div>
          )}

          {attempt && (phase === "testing" || phase === "done") && (
            <div className="wb-ssh-card">
              <div className="wb-ssh-card-head">
                <strong><LocalizedText id="STR-4130" /></strong>
                <span className="wb-mono">{attempt.serverName}</span>
                <span className="set-ssh-toolbar-gap" />
                <button type="button" className="set-link-btn" disabled={phase === "testing"} onClick={props.onRetest}><RefreshCw size={12} /> <LocalizedText id="STR-4131" /></button>
              </div>
              <ul className="wb-ssh-steps">
                {attempt.steps.map((item) => (
                  <SshStep
                    key={item.id}
                    tone={checkTone(item.status)}
                    text={checkText(item, attempt, authWord)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="wb-modal-foot">
          <span />
          <div className="wb-modal-actions">
            {phase === "testing" || phase === "done" ? (
              <button type="button" className="wb-btn wb-btn-accent" disabled={phase === "testing"} onClick={props.onDone}><LocalizedText id="STR-4132" /></button>
            ) : phase === "auto-login" ? (
              <button type="button" className="wb-btn wb-btn-accent" disabled><LocalizedText id="STR-4133" /></button>
            ) : phase === "auto-login-failed" ? (
              <button type="button" className="wb-btn wb-btn-accent" onClick={props.onSavePasswordLogin}><LocalizedText id="STR-4134" /></button>
            ) : phase === "offer-auto-login" ? null : (
              <>
                <button type="button" className="wb-btn wb-btn-ghost" disabled={connecting} onClick={onCancel}><LocalizedText id="STR-4135" /></button>
                {editing && onTest && (
                  <button type="button" className="wb-btn wb-btn-ghost" disabled={connecting} onClick={() => onTest(draft())}><FlaskConical size={13} /> <LocalizedText id="STR-4136" /></button>
                )}
                <button type="button" className="wb-btn wb-btn-accent" disabled={connecting} onClick={() => onSubmit(draft())} data-ssh-submit>
                  {connecting ? <><LoaderCircle size={13} className="wb-spin" /> <LocalizedText id="STR-4138" /></> : editing ? "저장" : "연결"}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const ATTEMPT_ERROR_TEXT: Record<Exclude<SshAttemptErrorKind, "password-not-allowed" | "key-rejected">, (server: string) => string> = {
  "unreachable": (server) => `${server} 에 연결할 수 없습니다`,
  "auth-failed": (server) => `${server} 에 로그인할 수 없습니다`,
  "fingerprint-changed": (server) => `${server} 서버 지문이 바뀌어 연결을 막았습니다`,
  "unsupported-os": () => "Linux · macOS 서버만 지원합니다",
  "agent-check-failed": (server) => `${server} 에이전트 확인 실패`,
  "key-install-failed": () => "자동 로그인 키 등록 실패",
  "key-verify-failed": () => "자동 로그인 확인 실패",
  "key-remove-failed": () => "자동 로그인 키 제거 실패",
};

function attemptErrorText(kind: Exclude<SshAttemptErrorKind, "password-not-allowed" | "key-rejected">, server: string): string {
  return ATTEMPT_ERROR_TEXT[kind](server);
}

/** `SHA256:xY9kP2…` → `SHA256:xY9…`, as the handoff's callout shows it. */
function shortFingerprint(value: string): string {
  const [algo, hash] = value.includes(":") ? value.split(":", 2) : ["", value];
  return `${algo ? algo + ":" : ""}${hash.slice(0, 3)}…`;
}

function Field({ label, children, error, help }: { label: string; children: ReactNode; error?: string; help?: string }) {
  return (
    <label className={"set-field set-ssh-field" + (error ? " is-error" : "")}>
      <span className="set-field-label">{label}</span>
      {children}
      {error && <span className="set-ssh-field-error"><TriangleAlert size={12} /> {error}</span>}
      {help && !error && <span className="set-ssh-field-help">{help}</span>}
    </label>
  );
}

function SecretInput({ value, onChange, placeholder, field }: { value: string; onChange: (value: string) => void; placeholder: string; field: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="set-input set-ssh-secret">
      <KeyRound size={14} />
      <input type={shown ? "text" : "password"} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} data-ssh-field={field} />
      <button type="button" className="set-ssh-eye" aria-label={shown ? localized("STR-4148") : localized("STR-4149")} onClick={() => setShown((current) => !current)}>
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
