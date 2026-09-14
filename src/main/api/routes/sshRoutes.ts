import { flag, required, text, type MethodRoute } from "../methodRegistry";
import type { SshServerDraft } from "../../../shared/sshServers";

function draft(p: Record<string, any>): SshServerDraft {
  const auth = p.auth && typeof p.auth === "object" ? p.auth : {};
  return {
    originalName: p.originalName ? text(p.originalName) : undefined,
    name: text(p.name), host: text(p.host), port: Number(p.port), user: text(p.user),
    auth: auth.kind === "auto"
      ? { kind: "auto" }
      : auth.kind === "key"
      ? { kind: "key", keyPath: text(auth.keyPath), ...(auth.passphrase !== undefined ? { passphrase: String(auth.passphrase) } : {}) }
      : { kind: "password", ...(auth.password !== undefined ? { password: String(auth.password) } : {}) },
  };
}

/** SSH settings, connection attempts and remote cwd checks. */
export const sshRoutes: MethodRoute[] = [
  { name: "ssh.list", http: "GET /api/ssh/servers", handler: (_p, ctx) => ctx.controller.listSshServers() },
  { name: "ssh.connectDraft", http: "POST /api/ssh/attempts", handler: (p, ctx) => ctx.controller.sshConnectDraft(draft(p)) },
  { name: "ssh.attempt", http: "GET /api/ssh/attempts/:id", handler: (p, ctx) => ctx.controller.sshAttemptState(required(p.id, "id")) },
  { name: "ssh.trustFingerprint", http: "POST /api/ssh/attempts/:id/trust-fingerprint", handler: (p, ctx) => ctx.controller.sshTrustFingerprint(required(p.id, "id")) },
  { name: "ssh.cancelAttempt", http: "POST /api/ssh/attempts/:id/cancel", handler: (p, ctx) => ctx.controller.sshCancelAttempt(required(p.id, "id")) },
  { name: "ssh.setupAutoLogin", http: "POST /api/ssh/attempts/:id/auto-login", handler: (p, ctx) => ctx.controller.sshSetupAutoLogin(required(p.id, "id")) },
  { name: "ssh.continueWithPassword", http: "POST /api/ssh/attempts/:id/password", handler: (p, ctx) => ctx.controller.sshContinueWithPassword(required(p.id, "id")) },
  { name: "ssh.savePasswordLogin", http: "POST /api/ssh/attempts/:id/save-password", handler: (p, ctx) => ctx.controller.sshSavePasswordLogin(required(p.id, "id")) },
  { name: "ssh.retest", http: "POST /api/ssh/attempts/:id/retest", handler: (p, ctx) => ctx.controller.sshRetest(required(p.id, "id")) },
  { name: "ssh.pickKeyFile", http: "POST /api/ssh/key-file/pick", remote: false, handler: (_p, ctx) => ctx.controller.sshPickKeyFile(ctx.windowId) },
  { name: "ssh.inspectKeyFile", http: "POST /api/ssh/key-file/inspect", handler: (p, ctx) => ctx.controller.sshInspectKeyFile(required(p.path, "path")) },
  { name: "ssh.testServer", http: "POST /api/ssh/servers/:name/test", handler: (p, ctx) => ctx.controller.sshTestServer(required(p.name, "name")) },
  { name: "ssh.reconnect", http: "POST /api/ssh/servers/:name/reconnect", handler: (p, ctx) => ctx.controller.sshReconnect(required(p.name, "name")) },
  { name: "ssh.trustNewFingerprint", http: "POST /api/ssh/servers/:name/trust-fingerprint", handler: (p, ctx) => ctx.controller.sshTrustNewFingerprint(required(p.name, "name")) },
  { name: "ssh.deleteServer", http: "DELETE /api/ssh/servers/:name", handler: (p, ctx) => ctx.controller.sshDeleteServer(required(p.name, "name"), { removeAutoLoginKey: flag(p.removeAutoLoginKey) }) },
  { name: "ssh.copyPublicKey", http: "POST /api/ssh/public-key/copy", remote: false, handler: (_p, ctx) => ctx.controller.sshCopyPublicKey() },
  { name: "ssh.checkRemotePath", http: "POST /api/ssh/path/check", handler: (p, ctx) => ctx.controller.sshCheckRemotePath(required(p.server, "server"), required(p.cwd, "cwd")) },
];
