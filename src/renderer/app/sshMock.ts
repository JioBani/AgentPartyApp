import type {
  SshAutoLoginStep, SshCheckItem, SshConnectAttempt, SshRemotePathCheck, SshServerDraft, SshServerView,
} from "../../shared/sshServers";
import type { SshApi } from "./sshClient";

/**
 * Explicit mock of the SSH feature, for building and reviewing the screens in
 * the real app before the feature lands (`localStorage["agentparty.sshMock"]="1"`).
 *
 * Draft behaviour is steered by the draft itself so a reviewer can reach every
 * state from the real form, with no hidden switches:
 *   host containing "unreachable" → 연결할 수 없음
 *   host containing "keyonly"     → 키 로그인만 허용 (password auth)
 *   key path containing "reject"  → 키 거부
 *   name containing "autofail"    → 자동 로그인 도중 실패
 *   port 2222                     → 지문이 바뀐 서버로 연결
 *   key path ending .pub / .ppk / .txt → 키 파일 오류
 * Remote paths: "/missing…" → 폴더 없음, relative → 절대 경로 아님.
 */

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

let servers: SshServerView[] = [
  {
    name: "dev-server", host: "10.0.0.5", port: 22, user: "dev", auth: "auto", connection: "connected",
    memberNames: [], lastTest: { at: iso(2), items: [
      { id: "connect", status: "ok" }, { id: "login", status: "ok" },
      { id: "agent:codex", status: "ok", installed: true },
      { id: "agent:claude-code", status: "ok", installed: true },
      { id: "agent:cursor", status: "fail", installed: false },
      { id: "agent:grok", status: "fail", installed: false },
    ] },
  },
  {
    name: "home-linux", host: "192.168.0.20", port: 22, user: "me", auth: "password", connection: "disconnected",
    memberNames: [], lastTest: { at: iso(60 * 26), items: [{ id: "agent:claude-code", status: "ok", installed: true }] },
  },
  {
    name: "aws-api-prod", host: "ec2-13-124-88-201.ap-northeast-2.compute.amazonaws.com", port: 22, user: "ubuntu",
    auth: "key", keyFileName: "aws-seoul.pem", connection: "reconnecting", memberNames: [],
  },
  { name: "school-gpu", host: "gpu.cs.univ.ac.kr", port: 2222, user: "s2026123", auth: "password", connection: "auth-failed", memberNames: [] },
  {
    name: "build-box", host: "10.0.3.14", port: 22, user: "ci", auth: "auto", connection: "fingerprint-changed", memberNames: [],
    fingerprintChange: { previous: "SHA256:ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv", next: "SHA256:Zz99Yy88Xx77Ww66Vv55Uu44Tt33Ss22Rr11Qq00Pp" },
  },
];

const serverListeners = new Set<(list: SshServerView[]) => void>();
const attemptListeners = new Set<(attempt: SshConnectAttempt) => void>();
const attempts = new Map<string, { attempt: SshConnectAttempt; draft: SshServerDraft; timers: number[] }>();

function emitServers() {
  const copy = servers.map((server) => ({ ...server }));
  serverListeners.forEach((listener) => listener(copy));
}

function push(id: string, patch: Partial<SshConnectAttempt>) {
  const entry = attempts.get(id);
  if (!entry) return;
  entry.attempt = { ...entry.attempt, ...patch };
  attemptListeners.forEach((listener) => listener(entry.attempt));
}

function later(id: string, ms: number, run: () => void) {
  const entry = attempts.get(id);
  if (!entry) return;
  entry.timers.push(window.setTimeout(run, ms));
}

const AGENTS: SshCheckItem[] = [
  { id: "agent:codex", status: "ok", installed: true },
  { id: "agent:claude-code", status: "ok", installed: true },
  { id: "agent:cursor", status: "fail", installed: false },
  { id: "agent:grok", status: "fail", installed: false },
];

function saveServer(draft: SshServerDraft, auth: SshServerView["auth"], items: SshCheckItem[]) {
  const existing = servers.find((server) => server.name === (draft.originalName ?? draft.name));
  const next: SshServerView = {
    name: draft.name, host: draft.host, port: draft.port, user: draft.user, auth,
    keyFileName: draft.auth.kind === "key" ? draft.auth.keyPath.split(/[\\/]/).pop() : undefined,
    connection: "connected", memberNames: existing?.memberNames ?? [], lastTest: { at: new Date().toISOString(), items },
  };
  servers = existing ? servers.map((server) => (server === existing ? next : server)) : [...servers, next];
  emitServers();
}

function runTest(id: string, auth: SshServerView["auth"]) {
  const entry = attempts.get(id);
  if (!entry) return;
  const base: SshCheckItem[] = [{ id: "connect", status: "ok" }, { id: "login", status: "ok" }];
  push(id, { phase: "testing", steps: [...base, { id: "agent:codex", status: "checking" }, { id: "agent:claude-code", status: "pending" }, { id: "agent:cursor", status: "pending" }, { id: "agent:grok", status: "pending" }] });
  later(id, 1400, () => {
    const items = [...base, ...AGENTS];
    push(id, { phase: "done", steps: items });
    saveServer(entry.draft, auth, items);
  });
}

function autoLoginSteps(statuses: SshAutoLoginStep["status"][], detail?: string): SshAutoLoginStep[] {
  const ids: SshAutoLoginStep["id"][] = ["key", "register", "verify", "forget-password"];
  return ids.map((id, index) => ({ id, status: statuses[index], detail: statuses[index] === "fail" ? detail : undefined }));
}

export const sshMockApi: SshApi = {
  listSshServers: async () => servers.map((server) => ({ ...server })),
  onSshServers: (listener) => { serverListeners.add(listener); return () => serverListeners.delete(listener); },
  onSshAttempt: (listener) => { attemptListeners.add(listener); return () => attemptListeners.delete(listener); },

  sshConnectDraft: async (draft) => {
    const fieldErrors = [];
    if (!draft.name) fieldErrors.push({ field: "name" as const, kind: "required" as const });
    else if (servers.some((server) => server.name === draft.name && server.name !== draft.originalName)) fieldErrors.push({ field: "name" as const, kind: "duplicate" as const });
    if (!draft.host) fieldErrors.push({ field: "host" as const, kind: "required" as const });
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) fieldErrors.push({ field: "port" as const, kind: "port-range" as const });
    if (!draft.user) fieldErrors.push({ field: "user" as const, kind: "required" as const });
    if (draft.auth.kind === "password" && !draft.auth.password && !draft.originalName) fieldErrors.push({ field: "password" as const, kind: "required" as const });
    if (draft.auth.kind === "key" && !draft.auth.keyPath) fieldErrors.push({ field: "keyPath" as const, kind: "required" as const });
    if (fieldErrors.length) return { fieldErrors };

    const attemptId = `mock-${Date.now()}`;
    attempts.set(attemptId, {
      draft, timers: [],
      attempt: { attemptId, serverName: draft.name, target: { host: draft.host, port: draft.port, user: draft.user }, phase: "connecting", steps: [{ id: "connect", status: "checking" }, { id: "login", status: "pending" }] },
    });
    queueMicrotask(() => push(attemptId, {}));
    later(attemptId, 1200, () => {
      if (draft.host.includes("unreachable")) {
        push(attemptId, { phase: "failed", steps: [{ id: "connect", status: "fail" }, { id: "login", status: "pending" }], error: { kind: "unreachable" } });
        return;
      }
      push(attemptId, draft.port === 2222
        ? { phase: "fingerprint", fingerprint: { sha256: "SHA256:Zz99Yy88Xx77Ww66Vv55Uu44Tt33Ss22Rr11Qq00Pp", previous: "SHA256:ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv" } }
        : { phase: "fingerprint", fingerprint: { sha256: "SHA256:ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv" } });
    });
    return { attemptId };
  },

  sshTrustFingerprint: async (id) => {
    const entry = attempts.get(id);
    if (!entry) return;
    push(id, { phase: "connecting", fingerprint: undefined, steps: [{ id: "connect", status: "ok" }, { id: "login", status: "checking" }] });
    later(id, 1000, () => {
      const { draft } = entry;
      if (draft.auth.kind === "password" && draft.host.includes("keyonly")) {
        push(id, { phase: "failed", steps: [{ id: "connect", status: "ok" }, { id: "login", status: "fail" }], error: { kind: "password-not-allowed" } });
      } else if (draft.auth.kind === "key" && draft.auth.keyPath.includes("reject")) {
        push(id, { phase: "failed", steps: [{ id: "connect", status: "ok" }, { id: "login", status: "fail" }], error: { kind: "key-rejected", keyFingerprint: "SHA256:xY9kP2mQ7vR4sT1uW8zA3bC6dE0fG5hJ" } });
      } else if (draft.auth.kind === "password") {
        push(id, { phase: "offer-auto-login", steps: [{ id: "connect", status: "ok" }, { id: "login", status: "ok" }] });
      } else {
        runTest(id, "key");
      }
    });
  },

  sshCancelAttempt: async (id) => {
    attempts.get(id)?.timers.forEach((timer) => window.clearTimeout(timer));
    attempts.delete(id);
  },

  sshSetupAutoLogin: async (id) => {
    const entry = attempts.get(id);
    if (!entry) return;
    const fail = entry.draft.name.includes("autofail");
    push(id, { phase: "auto-login", autoLoginSteps: autoLoginSteps(["checking", "pending", "pending", "pending"]) });
    later(id, 800, () => push(id, { autoLoginSteps: autoLoginSteps(["ok", "checking", "pending", "pending"]) }));
    later(id, 1600, () => push(id, { autoLoginSteps: autoLoginSteps(["ok", "ok", "checking", "pending"]) }));
    later(id, 2600, () => {
      if (fail) {
        push(id, { phase: "auto-login-failed", autoLoginSteps: autoLoginSteps(["ok", "ok", "fail", "pending"], "서버가 키 로그인을 허용하지 않습니다") });
        return;
      }
      push(id, { autoLoginSteps: autoLoginSteps(["ok", "ok", "ok", "checking"]) });
      later(id, 700, () => {
        push(id, { autoLoginSteps: autoLoginSteps(["ok", "ok", "ok", "ok"]) });
        runTest(id, "auto");
      });
    });
  },

  sshContinueWithPassword: async (id) => runTest(id, "password"),
  sshSavePasswordLogin: async (id) => runTest(id, "password"),
  sshRetest: async (id) => {
    const entry = attempts.get(id);
    if (entry) runTest(id, servers.find((server) => server.name === entry.draft.name)?.auth ?? "password");
  },

  sshPickKeyFile: async () => "C:\\Users\\dev\\.ssh\\aws-seoul.pem",
  sshInspectKeyFile: async (path) => {
    if (path.endsWith(".pub")) return { error: "public-key" };
    if (path.endsWith(".ppk")) return { error: "ppk" };
    if (path.endsWith(".txt")) return { error: "not-key" };
    return { fileName: path.split(/[\\/]/).pop() || path, fingerprint: "SHA256:xY9kP2mQ7vR4sT1uW8zA3bC6dE0fG5hJ", comment: "ec2-seoul-2026", locked: path.includes("locked") };
  },

  sshTestServer: async (name) => {
    servers = servers.map((server) => (server.name === name ? { ...server, connection: "connecting" } : server));
    emitServers();
    window.setTimeout(() => {
      servers = servers.map((server) => (server.name === name ? { ...server, connection: "connected", lastTest: { at: new Date().toISOString(), items: [{ id: "connect", status: "ok" }, { id: "login", status: "ok" }, ...AGENTS] } } : server));
      emitServers();
    }, 1200);
  },
  sshReconnect: async (name) => sshMockApi.sshTestServer(name),
  sshTrustNewFingerprint: async (name) => {
    servers = servers.map((server) => (server.name === name ? { ...server, connection: "connected", fingerprintChange: undefined } : server));
    emitServers();
  },
  sshDeleteServer: async (name, options) => {
    servers = servers.filter((server) => server.name !== name);
    emitServers();
    // "key-remove-fail" in the name reaches the partial-failure message.
    if (!options.removeAutoLoginKey) return { deleted: true, keyRemoval: "not-requested" };
    return name.includes("key-remove-fail")
      ? { deleted: true, keyRemoval: "failed", detail: "authorized_keys 를 쓸 수 없습니다" }
      : { deleted: true, keyRemoval: "removed" };
  },
  sshCopyPublicKey: async () => {
    await navigator.clipboard?.writeText("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForAgentPartyQA agentparty@this-pc");
  },
  sshCheckRemotePath: async (server, cwd): Promise<SshRemotePathCheck> => {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    const target = servers.find((entry) => entry.name === server);
    if (!target) return { ok: false, problem: "server-missing" };
    if (target.connection === "fingerprint-changed") return { ok: false, problem: "fingerprint-changed" };
    if (target.connection === "auth-failed") return { ok: false, problem: "auth-failed" };
    if (target.connection === "disconnected" && target.name === "home-linux") return { ok: false, problem: "unreachable" };
    if (!cwd.startsWith("/")) return { ok: false, problem: "not-absolute" };
    if (cwd.startsWith("/missing")) return { ok: false, problem: "missing" };
    return { ok: true };
  },
};
