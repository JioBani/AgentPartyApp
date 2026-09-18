import { Check, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { SshCheckStatus, SshConnectionState } from "../../shared/sshServers";

/**
 * The small status vocabulary every SSH screen shares — the server list, the
 * location picker, the member drawer and the add-server modal all say the same
 * word for the same state.
 *
 * Wording and tone live here, not in the feature: the backend reports a
 * `SshConnectionState` kind and this module is the one place that turns it into
 * what the design handoff says (`design_handoff_ssh_member/README.md`).
 */

export type SshTone = "ok" | "warn" | "fail" | "busy" | "idle";

export const SSH_CONNECTION_TONE: Record<SshConnectionState, SshTone> = {
  "connected": "ok",
  "disconnected": "idle",
  "connecting": "busy",
  "reconnecting": "warn",
  "unreachable": "fail",
  "auth-failed": "fail",
  "fingerprint-changed": "fail",
};

export const SSH_CONNECTION_LABEL: Record<SshConnectionState, string> = {
  "connected": "연결됨",
  "disconnected": "연결 안 됨",
  "connecting": "연결 중",
  "reconnecting": "끊김 · 재연결 중",
  "unreachable": "연결할 수 없음",
  "auth-failed": "인증 실패",
  "fingerprint-changed": "지문 변경",
};

export function checkTone(status: SshCheckStatus): SshTone {
  return status === "checking" ? "busy" : status === "pending" ? "idle" : status;
}

/** 상태 한 점 + 글자. */
export function SshStatus({ tone, label }: { tone: SshTone; label: string }) {
  return (
    <span className={"wb-ssh-status is-" + tone}>
      {tone === "busy" ? <LoaderCircle size={11} className="wb-spin" /> : <span className="wb-ssh-dot" />}
      {label}
    </span>
  );
}

export function SshConnectionStatus({ state }: { state: SshConnectionState }) {
  return <SshStatus tone={SSH_CONNECTION_TONE[state]} label={SSH_CONNECTION_LABEL[state]} />;
}

/** 대기 / 진행 중 / 완료 / 실패 · 주의 — auto-login progress and the connection test. */
export function SshStep({ tone, text, fixText }: {
  tone: SshTone;
  text: string;
  /** Raw reason under a failed step. */
  fixText?: string;
}) {
  const icon = tone === "ok" ? <Check size={13} strokeWidth={3} />
    : tone === "fail" ? <X size={13} strokeWidth={3} />
    : tone === "warn" ? <TriangleAlert size={13} />
    : tone === "busy" ? <LoaderCircle size={13} className="wb-spin" />
    : <span className="wb-ssh-step-wait" />;
  const hasFix = Boolean(fixText);
  return (
    <li className={"wb-ssh-step is-" + tone}>
      <span className="wb-ssh-step-ic">{icon}</span>
      <span className="wb-ssh-step-body">
        <span className="wb-ssh-step-text">{text}</span>
        {hasFix && (
          <span className="wb-ssh-step-fix">
            {fixText && <span>{fixText}</span>}
          </span>
        )}
      </span>
    </li>
  );
}
