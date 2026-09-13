export type SshAuthKind = "auto" | "password" | "key";

export type SshConnectionState = "connected" | "disconnected" | "connecting" | "reconnecting" | "unreachable" | "auth-failed" | "fingerprint-changed";
export type SshCheckStatus = "ok" | "warn" | "fail" | "checking" | "pending";

export interface SshCheckItem {
  id: "connect" | "login" | `agent:${string}`;
  status: SshCheckStatus;
  installed?: boolean;
}

export interface SshTestResult { at: string; items: SshCheckItem[] }

export interface SshServerView {
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuthKind;
  keyFileName?: string;
  connection: SshConnectionState;
  fingerprintChange?: { previous: string; next: string };
  memberNames: string[];
  lastTest?: SshTestResult;
}

/** Secrets in a draft are write-only and must never be echoed by an API. */
export interface SshServerDraft {
  originalName?: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: { kind: "password"; password?: string } | { kind: "key"; keyPath: string; passphrase?: string };
}

export type SshDraftField = "name" | "host" | "port" | "user" | "password" | "keyPath";
export interface SshFieldError { field: SshDraftField; kind: "required" | "duplicate" | "port-range" }

export type SshKeyInspection =
  | { fileName: string; fingerprint: string; comment?: string; locked: boolean }
  | { error: "public-key" | "ppk" | "not-key" };

export type SshAttemptErrorKind =
  | "password-not-allowed" | "key-rejected" | "auth-failed" | "unreachable" | "fingerprint-changed"
  | "unsupported-os" | "agent-check-failed" | "key-install-failed" | "key-verify-failed" | "key-remove-failed";

export interface SshAttemptError { kind: SshAttemptErrorKind; detail?: string; keyFingerprint?: string }
export type SshAutoLoginStepId = "key" | "register" | "verify" | "forget-password";
export interface SshAutoLoginStep { id: SshAutoLoginStepId; status: SshCheckStatus; detail?: string }

export interface SshConnectAttempt {
  attemptId: string;
  serverName: string;
  target: { host: string; port: number; user: string };
  phase: "connecting" | "fingerprint" | "offer-auto-login" | "auto-login" | "auto-login-failed" | "testing" | "done" | "failed";
  steps: SshCheckItem[];
  fingerprint?: { sha256: string; previous?: string };
  autoLoginSteps?: SshAutoLoginStep[];
  error?: SshAttemptError;
}

export type SshRemotePathProblem = "missing" | "not-absolute" | "unreachable" | "auth-failed" | "fingerprint-changed" | "server-missing";
export type SshRemotePathCheck = { ok: true } | { ok: false; problem: SshRemotePathProblem };

export interface SshDeleteResult {
  deleted: true;
  keyRemoval: "not-requested" | "removed" | "failed";
  detail?: string;
}
