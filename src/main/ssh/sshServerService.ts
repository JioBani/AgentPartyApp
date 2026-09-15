import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SshConnectAttempt, SshDeleteResult, SshFieldError, SshKeyInspection,
  SshRemoteBrowseProblem, SshRemoteDirectoryResult, SshRemotePathCheck, SshRemotePathSuggestions,
  SshServerDraft, SshServerView, SshTestResult,
  SshAutoLoginStep, SshRemotePathProblem,
} from "../../shared/sshServers";
import type { SshMessageUnavailable } from "../../shared/types";
import type { StoredSshServer } from "./sshServerStore";
import { SshServerStore } from "./sshServerStore";
import { shellQuote, SshRemoteFileError, SshTransport, SshTransportError, type SshCredential, type SshTarget } from "./sshTransport";
import { log } from "../logger";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { utils: sshUtils } = require("ssh2") as {
  utils: {
    generateKeyPairSync(type: "ed25519", options: { comment: string }): { private: string; public: string };
    parseKey(data: string | Buffer, passphrase?: string): unknown | Error;
  };
};

export interface SshServerServiceDeps {
  store: SshServerStore;
  transport: SshTransport;
  memberNames(server: string): Promise<string[]>;
  renameMemberLocations(from: string, to: string): Promise<void>;
  invalidateServer?(server: string): void;
  recoverMembers?(server: string): Promise<void>;
}

interface PendingAttempt { state: SshConnectAttempt; draft: SshServerDraft; fingerprint?: string; cleanupTimer?: NodeJS.Timeout; cancelled?: boolean; autoLoginPublicKey?: string }

const REMOTE_DIRECTORY_LIMIT = 1_000;
const REMOTE_SUGGESTION_LIMIT = 20;

class SshAttemptFailure extends Error {
  constructor(readonly kind: import("../../shared/sshServers").SshAttemptErrorKind, message: string) {
    super(message);
  }
}

export class SshDraftValidationError extends Error {
  constructor(readonly fieldErrors: SshFieldError[]) {
    super("SSH 서버 입력값을 확인하세요");
  }
}

export class SshServerService extends EventEmitter {
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly connectionStates = new Map<string, SshServerView["connection"]>();
  private readonly fingerprintChanges = new Map<string, { previous: string; next: string }>();
  private readonly serversNeedingRecovery = new Set<string>();

  constructor(private readonly deps: SshServerServiceDeps) {
    super();
    deps.transport.on("state", (event) => {
      const state = event as { server?: unknown; connection?: unknown; fingerprint?: unknown };
      if (typeof state.server === "string" && typeof state.connection === "string") {
        this.connectionStates.set(state.server, state.connection as SshServerView["connection"]);
        if (["disconnected", "unreachable", "auth-failed", "fingerprint-changed"].includes(state.connection)) {
          this.serversNeedingRecovery.add(state.server);
        }
        if (state.connection === "fingerprint-changed" && typeof state.fingerprint === "string") {
          try {
            const stored = this.deps.store.get(state.server);
            if (stored) {
              this.fingerprintChanges.set(state.server, { previous: stored.hostFingerprint, next: state.fingerprint });
            }
          } catch (error) {
            log("error", "ssh", "지문 변경 정보를 기록하지 못했습니다", { server: state.server, error: messageOf(error) });
          }
        } else if (state.connection === "connected") {
          this.fingerprintChanges.delete(state.server);
        }
      }
      this.emitServers();
    });
  }

  dispose(): void {
    let storedNames: string[] = [];
    try { storedNames = this.deps.store.list().map((server) => server.name); }
    catch (error) { log("error", "ssh", "종료 중 SSH 서버 목록을 읽지 못했습니다", { error: messageOf(error) }); }
    const names = new Set(storedNames);
    for (const attempt of this.attempts.values()) {
      attempt.cancelled = true;
      clearTimeout(attempt.cleanupTimer);
      forgetDraftSecrets(attempt.draft);
      names.add(attempt.draft.name);
    }
    this.attempts.clear();
    for (const name of names) this.deps.transport.disconnect(name);
    this.removeAllListeners();
  }

  async listServers(): Promise<SshServerView[]> {
    return Promise.all(this.deps.store.list().map(async (server) => ({
      name: server.name, host: server.host, port: server.port, user: server.user,
      auth: server.auth, keyFileName: server.keyFileName,
      connection: this.connectionStates.get(server.name) || "disconnected",
      ...(this.fingerprintChanges.get(server.name) ? { fingerprintChange: this.fingerprintChanges.get(server.name) } : {}),
      memberNames: await this.deps.memberNames(server.name),
      lastTest: server.lastTest,
    })));
  }

  /**
   * Answers whether a message may be handed to a member on this server now.
   * This deliberately does not reconnect: a disconnected server is recovered
   * by the user's explicit reconnect action, and a send must never become a
   * hidden retry or an invisible queue.
   */
  messageUnavailable(serverName: string): SshMessageUnavailable | undefined {
    if (!this.deps.store.get(serverName)) return { server: serverName, problem: "server-missing" };
    const connection = this.connectionStates.get(serverName) || "disconnected";
    if (connection === "connected") return undefined;
    if (connection === "fingerprint-changed") return { server: serverName, problem: "fingerprint-changed" };
    if (connection === "auth-failed") return { server: serverName, problem: "auth-failed" };
    return { server: serverName, problem: "unreachable" };
  }

  connectDraft(draft: SshServerDraft): { attemptId: string } {
    const stored = this.deps.store.list();
    const fieldErrors = validateDraft(draft, stored);
    if (fieldErrors.length === 0 && draft.auth.kind === "key" && !keyPassphraseMatches(draft.auth.keyPath, draft.auth.passphrase)) {
      fieldErrors.push({ field: "passphrase", kind: "passphrase-wrong" });
    }
    if (fieldErrors.length) throw new SshDraftValidationError(fieldErrors);
    if (draft.originalName) this.serversNeedingRecovery.add(draft.originalName);
    this.deps.transport.disconnect(draft.originalName || draft.name);
    if (draft.originalName && draft.originalName !== draft.name) this.deps.transport.disconnect(draft.name);
    const attemptId = randomUUID();
    const pending: PendingAttempt = {
      draft,
      state: {
        attemptId, serverName: draft.name,
        target: { host: draft.host, port: draft.port, user: draft.user },
        phase: "connecting",
        steps: [{ id: "connect", status: "checking" }, { id: "login", status: "pending" }],
      },
    };
    this.trackAttempt(pending);
    this.push(pending);
    void this.discoverFingerprint(pending);
    return { attemptId };
  }

  cancelAttempt(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId);
    const rollback = attempt.autoLoginPublicKey
      ? { target: targetOf(attempt.draft), credential: this.credentialForDraft(attempt.draft), fingerprint: attempt.fingerprint!, publicKey: attempt.autoLoginPublicKey }
      : undefined;
    attempt.cancelled = true;
    this.deps.transport.disconnect(attempt.draft.name);
    forgetDraftSecrets(attempt.draft);
    clearTimeout(attempt.cleanupTimer);
    this.attempts.delete(attemptId);
    if (rollback) void this.rollbackCancelledAutoLogin(attempt.draft.name, rollback);
  }

  attemptState(attemptId: string): SshConnectAttempt {
    return structuredClone(this.requireAttempt(attemptId).state);
  }

  trustFingerprint(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.state.phase !== "fingerprint" || !attempt.fingerprint) throw new Error("지문 승인을 기다리는 연결이 아닙니다");
    attempt.state = { ...attempt.state, phase: "connecting", steps: [{ id: "connect", status: "ok" }, { id: "login", status: "checking" }] };
    this.push(attempt);
    void this.login(attempt);
  }

  continueWithPassword(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId);
    this.requirePhase(attempt, "offer-auto-login");
    void this.finishPassword(attempt);
  }
  savePasswordLogin(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId);
    this.requirePhase(attempt, "auto-login-failed");
    void this.finishPassword(attempt);
  }
  setupAutoLogin(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId);
    this.requirePhase(attempt, "offer-auto-login");
    void this.installAutoLogin(attempt);
  }

  async testServer(name: string): Promise<{ attemptId: string }> {
    const server = this.requireServer(name);
    const attemptId = randomUUID();
    const pending: PendingAttempt = {
      draft: draftFromStored(server),
      fingerprint: server.hostFingerprint,
      state: { attemptId, serverName: name, target: targetOf(server), phase: "testing", steps: [{ id: "connect", status: "checking" }, { id: "login", status: "pending" }] },
    };
    this.trackAttempt(pending);
    this.push(pending);
    void this.testStored(pending, server);
    return { attemptId };
  }

  reconnect(name: string): Promise<{ attemptId: string }> {
    this.requireServer(name);
    this.deps.invalidateServer?.(name);
    this.deps.transport.disconnect(name);
    this.connectionStates.set(name, "reconnecting");
    this.emitServers();
    return this.testServer(name);
  }

  retest(attemptId: string): void {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.state.phase !== "failed" && attempt.state.phase !== "auto-login-failed") {
      throw new Error("현재 단계에서는 연결을 다시 시험할 수 없습니다");
    }
    attempt.state = { ...attempt.state, phase: "connecting", error: undefined, steps: [{ id: "connect", status: "checking" }, { id: "login", status: "pending" }] };
    this.push(attempt);
    void this.discoverFingerprint(attempt);
  }

  publicKey(): string {
    return this.deps.store.autoLoginIdentity(generateAutoLoginKey).publicKey;
  }

  async trustNewFingerprint(name: string): Promise<{ attemptId: string }> {
    const server = this.requireServer(name);
    const next = await this.deps.transport.fingerprint(targetOf(server));
    server.hostFingerprint = next;
    this.deps.store.save(server, name);
    this.deps.invalidateServer?.(name);
    return this.testServer(name);
  }

  async deleteServer(name: string, removeAutoLoginKey: boolean): Promise<SshDeleteResult> {
    const server = this.requireServer(name);
    let keyRemoval: SshDeleteResult["keyRemoval"] = "not-requested";
    let detail: string | undefined;
    if (removeAutoLoginKey && server.auth === "auto" && !server.autoLoginPublicKey) {
      keyRemoval = "failed";
      detail = "등록한 자동 로그인 키 정보가 없습니다";
    } else if (removeAutoLoginKey && server.auth === "auto" && server.autoLoginPublicKey) {
      try {
        const connection = await this.connectStored(server);
        await removeAuthorizedKey(connection, server.autoLoginPublicKey);
        keyRemoval = "removed";
      } catch (error) {
        keyRemoval = "failed";
        detail = messageOf(error).trim() || undefined;
      }
    }
    // Delete the stored row before disconnecting. `disconnect` emits a state
    // event synchronously, and that event starts an async list refresh. When
    // the row was deleted afterwards, the stale refresh (which still had to
    // resolve member names) could arrive after the empty refresh and put the
    // deleted server back on screen until the settings view was reopened.
    this.deps.store.delete(name);
    this.connectionStates.delete(name);
    this.fingerprintChanges.delete(name);
    this.serversNeedingRecovery.delete(name);
    this.deps.transport.disconnect(name);
    this.deps.invalidateServer?.(name);
    await this.emitServers();
    return { deleted: true, keyRemoval, ...(detail ? { detail } : {}) };
  }

  async checkRemotePath(serverName: string, cwd: string): Promise<SshRemotePathCheck> {
    if (!cwd.startsWith("/")) return { ok: false, problem: "not-absolute" };
    const server = this.deps.store.get(serverName);
    if (!server) return { ok: false, problem: "server-missing" };
    try {
      const connection = await this.connectStored(server);
      const quoted = shellQuote(cwd);
      const result = await connection.exec(`if test ! -d ${quoted}; then printf __AP_MISSING__; elif test ! -r ${quoted} || test ! -x ${quoted}; then printf __AP_DENIED__; else printf __AP_OK__; fi`);
      if (result.stdout.includes("__AP_OK__")) return { ok: true };
      return { ok: false, problem: result.stdout.includes("__AP_DENIED__") ? "denied" : "missing" };
    } catch (error) {
      return { ok: false, problem: problemOf(error) };
    }
  }

  async remoteHome(serverName: string): Promise<SshRemoteDirectoryResult> {
    const server = this.deps.store.get(serverName);
    if (!server) return { ok: false, path: ".", problem: "server-missing" };
    try {
      const connection = await this.connectStored(server);
      const home = await connection.homeDirectory();
      return await this.readRemoteDirectory(connection, home);
    } catch (error) {
      return remoteBrowseFailure(".", error);
    }
  }

  async listRemoteDirectories(serverName: string, remotePath: string): Promise<SshRemoteDirectoryResult> {
    if (!remotePath.startsWith("/")) return { ok: false, path: remotePath, problem: "not-absolute" };
    const server = this.deps.store.get(serverName);
    if (!server) return { ok: false, path: remotePath, problem: "server-missing" };
    try {
      const connection = await this.connectStored(server);
      return await this.readRemoteDirectory(connection, remotePath);
    } catch (error) {
      return remoteBrowseFailure(remotePath, error);
    }
  }

  async suggestRemotePaths(serverName: string, input: string): Promise<SshRemotePathSuggestions> {
    if (!input) {
      const home = await this.remoteHome(serverName);
      return home.ok
        ? { ok: true, input, items: home.directories.slice(0, REMOTE_SUGGESTION_LIMIT) }
        : { ok: false, input, problem: home.problem, ...(home.detail ? { detail: home.detail } : {}) };
    }
    if (!input.startsWith("/")) return { ok: false, input, problem: "not-absolute" };
    const trailingSlash = input.endsWith("/");
    const directory = trailingSlash ? path.posix.normalize(input) : path.posix.dirname(input);
    const prefix = trailingSlash ? "" : path.posix.basename(input).toLocaleLowerCase();
    const listed = await this.listRemoteDirectories(serverName, directory);
    return listed.ok
      ? {
          ok: true,
          input,
          items: listed.directories
            .filter((entry) => entry.name.toLocaleLowerCase().startsWith(prefix))
            .slice(0, REMOTE_SUGGESTION_LIMIT),
        }
      : { ok: false, input, problem: listed.problem, ...(listed.detail ? { detail: listed.detail } : {}) };
  }

  async runtimeConnection(serverName: string) {
    return this.connectStored(this.requireServer(serverName));
  }

  private async readRemoteDirectory(
    connection: Awaited<ReturnType<SshTransport["connect"]>>,
    remotePath: string,
  ): Promise<SshRemoteDirectoryResult> {
    const listing = await connection.listDirectories(remotePath, REMOTE_DIRECTORY_LIMIT);
    const parent = listing.path === "/" ? undefined : path.posix.dirname(listing.path);
    return {
      ok: true,
      path: listing.path,
      ...(parent ? { parent } : {}),
      directories: listing.entries,
      ...(listing.truncated ? { truncated: true } : {}),
    };
  }

  inspectKeyFile(file: string): SshKeyInspection {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".pub") return { error: "public-key" };
    if (ext === ".ppk") return { error: "ppk" };
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      const detail = messageOf(error).trim() || "Could not read the file";
      log("error", "ssh", "SSH key file inspection could not read the file", { file, detail });
      return { error: "inspect-failed", detail };
    }
    if (/^PuTTY-User-Key-File-/m.test(text)) return { error: "ppk" };
    if (/^(?:ssh-|ecdsa-)[A-Za-z0-9-]+\s+[A-Za-z0-9+/=]+/m.test(text)) return { error: "public-key" };
    if (!/-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----/.test(text)) return { error: "not-key" };
    // Use the OpenSSH executable beside ssh.exe on Windows. Electron does not
    // inherit the same PATH as an interactive shell on every installation.
    const executable = sshKeygenExecutable();
    const result = spawnSync(executable, ["-lf", file, "-E", "sha256"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      const detail = result.error.message.trim() || "Could not start ssh-keygen";
      log("error", "ssh", "SSH key file inspection could not start ssh-keygen", { file, executable, detail });
      return { error: "inspect-failed", detail };
    }
    if (result.status !== 0) {
      log("warn", "ssh", "ssh-keygen rejected an SSH private key file", {
        file, executable, status: result.status, detail: result.stderr.trim() || undefined,
      });
      return { error: "not-key" };
    }
    const output = result.stdout.trim();
    const match = /^\d+\s+(SHA256:\S+)(?:\s+(.+?))?\s+\([^()]+\)$/.exec(output);
    if (!match) {
      const detail = "ssh-keygen returned an unsupported result";
      log("error", "ssh", detail, { file, executable, output });
      return { error: "inspect-failed", detail };
    }
    const comment = match[2] && match[2] !== "no comment" ? match[2] : undefined;
    const locked = privateKeyIsLocked(text);
    if (locked === undefined) {
      const detail = "OpenSSH private key encryption metadata is invalid";
      log("error", "ssh", detail, { file });
      return { error: "inspect-failed", detail };
    }
    return {
      fileName: path.basename(file), fingerprint: match[1],
      ...(comment ? { comment } : {}),
      locked,
    };
  }

  private async discoverFingerprint(attempt: PendingAttempt): Promise<void> {
    try {
      const fingerprint = await this.deps.transport.fingerprint(targetOf(attempt.draft));
      if (attempt.cancelled) return;
      attempt.fingerprint = fingerprint;
      const previous = attempt.draft.originalName ? this.deps.store.get(attempt.draft.originalName)?.hostFingerprint : undefined;
      if (previous === fingerprint) {
        attempt.state = { ...attempt.state, phase: "connecting", fingerprint: { sha256: fingerprint }, steps: [{ id: "connect", status: "ok" }, { id: "login", status: "checking" }] };
        this.push(attempt);
        await this.login(attempt);
        return;
      }
      attempt.state = { ...attempt.state, phase: "fingerprint", fingerprint: { sha256: fingerprint, ...(previous && previous !== fingerprint ? { previous } : {}) }, steps: [{ id: "connect", status: "ok" }, { id: "login", status: "pending" }] };
      this.push(attempt);
    } catch (error) { if (!attempt.cancelled) this.fail(attempt, error); }
  }

  private async login(attempt: PendingAttempt): Promise<void> {
    try {
      const credential = this.credentialForDraft(attempt.draft);
      const connection = await this.deps.transport.connect(attempt.draft.name, targetOf(attempt.draft), credential, attempt.fingerprint!);
      if (attempt.cancelled) return;
      const os = await connection.exec("uname -s");
      if (attempt.cancelled) return;
      if (os.code !== 0 || !/^(Linux|Darwin)\s*$/i.test(os.stdout)) {
        throw new SshAttemptFailure("unsupported-os", os.stdout.trim() || os.stderr.trim() || "지원하지 않는 운영체제");
      }
      attempt.state = { ...attempt.state, phase: attempt.draft.auth.kind === "password" ? "offer-auto-login" : "testing", steps: [{ id: "connect", status: "ok" }, { id: "login", status: "ok" }] };
      this.push(attempt);
      if (attempt.draft.auth.kind === "key") await this.testAndSave(attempt, connection, "key");
      else if (attempt.draft.auth.kind === "auto") await this.testAndSave(attempt, connection, "auto");
    } catch (error) { if (!attempt.cancelled) this.fail(attempt, error); }
  }

  private async finishPassword(attempt: PendingAttempt): Promise<void> {
    try {
      const connection = await this.deps.transport.connect(attempt.draft.name, targetOf(attempt.draft), this.credentialForDraft(attempt.draft), attempt.fingerprint!);
      if (attempt.cancelled) return;
      await this.testAndSave(attempt, connection, "password");
    } catch (error) { if (!attempt.cancelled) this.fail(attempt, error); }
  }

  private async installAutoLogin(attempt: PendingAttempt): Promise<void> {
    const steps: SshAutoLoginStep[] = ["key", "register", "verify", "forget-password"].map((id) => ({ id: id as SshAutoLoginStep["id"], status: "pending" }));
    attempt.state = { ...attempt.state, phase: "auto-login", autoLoginSteps: steps };
    this.push(attempt);
    let registeredPublicKey: string | undefined;
    try {
      steps[0].status = "checking"; this.push(attempt);
      const pair = this.deps.store.autoLoginIdentity(generateAutoLoginKey);
      attempt.autoLoginPublicKey = pair.publicKey;
      if (attempt.cancelled) return;
      steps[0].status = "ok"; steps[1].status = "checking"; this.push(attempt);
      const passwordConnection = await this.deps.transport.connect(attempt.draft.name, targetOf(attempt.draft), this.credentialForDraft(attempt.draft), attempt.fingerprint!);
      if (attempt.cancelled) return;
      await appendAuthorizedKey(passwordConnection, pair.publicKey);
      registeredPublicKey = pair.publicKey;
      if (attempt.cancelled) return;
      steps[1].status = "ok"; steps[2].status = "checking"; this.push(attempt);
      this.deps.transport.disconnect(attempt.draft.name);
      const keyConnection = await this.deps.transport.connect(attempt.draft.name, targetOf(attempt.draft), { kind: "key", privateKey: pair.privateKey }, attempt.fingerprint!);
      if (attempt.cancelled) return;
      const verify = await keyConnection.exec("true");
      if (verify.code !== 0) throw new Error(verify.stderr || "키로 다시 로그인하지 못했습니다");
      steps[2].status = "ok"; steps[3].status = "checking"; this.push(attempt);
      await this.testAndSave(attempt, keyConnection, "auto", pair);
      steps[3].status = "ok"; this.push(attempt);
    } catch (error) {
      if (attempt.cancelled) return;
      let cleanupDetail = "";
      if (registeredPublicKey) {
        try {
          this.deps.transport.disconnect(attempt.draft.name);
          const passwordConnection = await this.deps.transport.connect(
            attempt.draft.name,
            targetOf(attempt.draft),
            this.credentialForDraft(attempt.draft),
            attempt.fingerprint!,
          );
          await removeAuthorizedKey(passwordConnection, registeredPublicKey);
        } catch (cleanupError) {
          cleanupDetail = messageOf(cleanupError).trim();
        }
      }
      const active = steps.find((step) => step.status === "checking");
      const detail = [messageOf(error).trim(), cleanupDetail].filter(Boolean).join(" / ");
      if (active) { active.status = "fail"; active.detail = detail; }
      attempt.state = { ...attempt.state, phase: "auto-login-failed", autoLoginSteps: steps, error: { kind: active?.id === "verify" ? "key-verify-failed" : active?.id === "register" ? "key-install-failed" : "auth-failed", detail } };
      this.push(attempt);
    }
  }

  private async testAndSave(attempt: PendingAttempt, connection: Awaited<ReturnType<SshTransport["connect"]>>, auth: "password" | "key" | "auto", pair?: { privateKey: string; publicKey: string }): Promise<void> {
    attempt.state = { ...attempt.state, phase: "testing" }; this.push(attempt);
    const test = await runChecks(connection);
    if (attempt.cancelled) return;
    const old = attempt.draft.originalName ? this.deps.store.get(attempt.draft.originalName) : undefined;
    const secret = auth === "auto" && pair ? { privateKey: pair.privateKey } : secretOfDraft(attempt.draft, old);
    const autoLoginPublicKey = pair?.publicKey || (auth === "auto" ? old?.autoLoginPublicKey : undefined);
    const stored: StoredSshServer = {
      name: attempt.draft.name, host: attempt.draft.host, port: attempt.draft.port, user: attempt.draft.user,
      auth, hostFingerprint: attempt.fingerprint!, secret, lastTest: test,
      ...(auth === "key" ? { keyFileName: path.basename((attempt.draft.auth as any).keyPath) } : {}),
      ...(autoLoginPublicKey ? { autoLoginPublicKey } : {}),
    };
    this.deps.store.save(stored, attempt.draft.originalName);
    if (attempt.draft.originalName && attempt.draft.originalName !== attempt.draft.name) {
      try {
        await this.deps.renameMemberLocations(attempt.draft.originalName, attempt.draft.name);
      } catch (error) {
        // Restore the old server record so a failed cross-store rename cannot
        // strand every member at an alias that no longer exists.
        if (old) this.deps.store.save(old, attempt.draft.name);
        throw error;
      }
    }
    if (attempt.draft.originalName) this.deps.invalidateServer?.(attempt.draft.originalName);
    this.deps.invalidateServer?.(attempt.draft.name);
    const recoverMembers = this.serversNeedingRecovery.delete(attempt.draft.originalName || attempt.draft.name)
      || this.serversNeedingRecovery.delete(attempt.draft.name);
    if (recoverMembers) {
      await this.deps.recoverMembers?.(attempt.draft.name);
    }
    attempt.state = { ...attempt.state, phase: "done", steps: test.items };
    this.push(attempt); this.emitServers(); this.completeAttempt(attempt);
  }

  private async testStored(attempt: PendingAttempt, server: StoredSshServer): Promise<void> {
    try {
      const current = await this.deps.transport.fingerprint(targetOf(server));
      if (attempt.cancelled) return;
      if (current !== server.hostFingerprint) {
        this.connectionStates.set(server.name, "fingerprint-changed");
        this.fingerprintChanges.set(server.name, { previous: server.hostFingerprint, next: current });
        throw new SshTransportError("fingerprint-changed", `${server.name} 지문이 바뀌었습니다`, current);
      }
      const connection = await this.connectStored(server);
      if (attempt.cancelled) return;
      const test = await runChecks(connection);
      if (attempt.cancelled) return;
      server.lastTest = test; this.deps.store.save(server, server.name);
      this.connectionStates.set(server.name, "connected");
      this.fingerprintChanges.delete(server.name);
      const recoverMembers = this.serversNeedingRecovery.delete(server.name);
      if (recoverMembers) {
        await this.deps.recoverMembers?.(server.name);
      }
      attempt.state = { ...attempt.state, phase: "done", steps: test.items }; this.push(attempt); this.emitServers(); this.completeAttempt(attempt);
    } catch (error) { if (!attempt.cancelled) this.fail(attempt, error); }
  }

  private connectStored(server: StoredSshServer) { return this.deps.transport.connect(server.name, targetOf(server), credentialOfStored(server), server.hostFingerprint); }
  private credentialForDraft(draft: SshServerDraft): SshCredential {
    return credentialOfDraft(draft, draft.originalName ? this.deps.store.get(draft.originalName) : undefined);
  }
  private async rollbackCancelledAutoLogin(
    server: string,
    rollback: { target: SshTarget; credential: SshCredential; fingerprint: string; publicKey: string },
  ): Promise<void> {
    try {
      const connection = await this.deps.transport.connect(server, rollback.target, rollback.credential, rollback.fingerprint);
      await removeAuthorizedKey(connection, rollback.publicKey);
    } catch (error) {
      log("error", "ssh", "취소한 자동 로그인 키를 삭제하지 못했습니다", { server, error: messageOf(error) });
    } finally {
      this.deps.transport.disconnect(server);
    }
  }
  private requireServer(name: string) { const server = this.deps.store.get(name); if (!server) throw new Error(`${name} 서버가 없습니다`); return server; }
  private requireAttempt(id: string) { const value = this.attempts.get(id); if (!value) throw new Error("연결 시도를 찾을 수 없습니다"); return value; }
  private requirePhase(attempt: PendingAttempt, phase: SshConnectAttempt["phase"]) {
    if (attempt.state.phase !== phase) {
      throw new Error("현재 연결 단계에서는 이 동작을 할 수 없습니다");
    }
  }
  private push(attempt: PendingAttempt) { this.emit("attempt", structuredClone(attempt.state)); }
  private completeAttempt(attempt: PendingAttempt) {
    forgetDraftSecrets(attempt.draft);
    clearTimeout(attempt.cleanupTimer);
    // Keep the terminal state briefly so HTTP automation can observe fast
    // connections that finish before its first poll. Credentials have already
    // been removed from the in-memory draft above.
    attempt.cleanupTimer = setTimeout(() => {
      this.attempts.delete(attempt.state.attemptId);
    }, 5 * 60_000);
    attempt.cleanupTimer.unref?.();
  }
  private trackAttempt(attempt: PendingAttempt) {
    attempt.cleanupTimer = setTimeout(() => {
      if (this.attempts.has(attempt.state.attemptId)) this.cancelAttempt(attempt.state.attemptId);
    }, 30 * 60_000);
    attempt.cleanupTimer.unref?.();
    this.attempts.set(attempt.state.attemptId, attempt);
  }
  private emitServers(): Promise<void> {
    return this.listServers()
      .then((servers) => { this.emit("servers", servers); })
      .catch((error) => log("error", "ssh", "SSH 서버 목록을 갱신하지 못했습니다", { error: messageOf(error) }));
  }
  private fail(attempt: PendingAttempt, error: unknown) {
    const kind = error instanceof SshTransportError || error instanceof SshAttemptFailure ? error.kind : "unreachable";
    let keyFingerprint: string | undefined;
    if (kind === "key-rejected" && attempt.draft.auth.kind === "key") {
      const inspected = this.inspectKeyFile(attempt.draft.auth.keyPath);
      if (!("error" in inspected)) keyFingerprint = inspected.fingerprint;
    }
    const detail = attemptFailureDetail(kind, error);
    attempt.state = {
      ...attempt.state,
      phase: "failed",
      error: {
        kind,
        ...(detail ? { detail } : {}),
        ...(keyFingerprint ? { keyFingerprint } : {}),
      },
      ...(kind === "fingerprint-changed"
        ? { fingerprint: { sha256: error instanceof SshTransportError ? error.fingerprint || "" : "", previous: attempt.fingerprint } }
        : {}),
    };
    this.push(attempt);
  }
}

async function runChecks(connection: Awaited<ReturnType<SshTransport["connect"]>>): Promise<SshTestResult> {
  const items: SshTestResult["items"] = [{ id: "connect", status: "ok" }, { id: "login", status: "ok" }];
  for (const [id, command] of [["codex", "command -v codex"], ["claude-code", "command -v claude"], ["cursor", "command -v cursor-agent"], ["grok", "command -v grok"]] as const) {
    const installed = await connection.exec(command);
    items.push({ id: `agent:${id}`, status: installed.code === 0 ? "ok" : "fail", installed: installed.code === 0 });
  }
  return { at: new Date().toISOString(), items };
}

async function appendAuthorizedKey(connection: Awaited<ReturnType<SshTransport["connect"]>>, publicKey: string) {
  const marker = publicKey.trim();
  const command = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -Fqx ${shellQuote(marker)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(marker)} >> ~/.ssh/authorized_keys`;
  const result = await connection.exec(command); if (result.code !== 0) throw new Error(result.stderr || "자동 로그인 키를 등록하지 못했습니다");
}

async function removeAuthorizedKey(connection: Awaited<ReturnType<SshTransport["connect"]>>, publicKey: string) {
  const result = await connection.exec(`test ! -f ~/.ssh/authorized_keys || { grep -Fvx ${shellQuote(publicKey.trim())} ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.agentparty.tmp; mv ~/.ssh/authorized_keys.agentparty.tmp ~/.ssh/authorized_keys; }`);
  if (result.code !== 0) throw new Error(result.stderr || "자동 로그인 키를 삭제하지 못했습니다");
}

function generateAutoLoginKey(): { privateKey: string; publicKey: string } {
  const pair = sshUtils.generateKeyPairSync("ed25519", { comment: "agentparty-auto-login" });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

function validateDraft(draft: SshServerDraft, servers: StoredSshServer[]): SshFieldError[] {
  const errors: SshFieldError[] = [];
  for (const field of ["name", "host", "user"] as const) if (!draft[field]?.trim()) errors.push({ field, kind: "required" });
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) errors.push({ field: "port", kind: "port-range" });
  if (servers.some((server) => server.name === draft.name) && draft.originalName !== draft.name) errors.push({ field: "name", kind: "duplicate" });
  const previous = draft.originalName ? servers.find((server) => server.name === draft.originalName) : undefined;
  if (draft.auth.kind === "auto" && (!previous || previous.auth !== "auto" || !previous.secret.privateKey)) errors.push({ field: "password", kind: "required" });
  if (draft.auth.kind === "password" && !draft.auth.password && !(previous?.auth === "password" && previous.secret.password)) errors.push({ field: "password", kind: "required" });
  if (draft.auth.kind === "key" && !draft.auth.keyPath) errors.push({ field: "keyPath", kind: "required" });
  return errors;
}
function targetOf(value: { host: string; port: number; user: string }): SshTarget { return { host: value.host, port: value.port, user: value.user }; }
function credentialOfDraft(draft: SshServerDraft, old?: StoredSshServer): SshCredential {
  if (draft.auth.kind === "auto") {
    if (old?.auth !== "auto" || !old.secret.privateKey) throw new Error(`${draft.name} 자동 로그인 키가 없습니다`);
    return { kind: "key", privateKey: old.secret.privateKey };
  }
  if (draft.auth.kind === "password") {
    const password = draft.auth.password || (old?.auth === "password" ? old.secret.password : undefined);
    if (!password) throw new Error(`${draft.name} 의 비밀번호를 입력하세요`);
    return { kind: "password", password };
  }
  return { kind: "key", privateKey: fs.readFileSync(draft.auth.keyPath, "utf8"), ...(draft.auth.passphrase ? { passphrase: draft.auth.passphrase } : {}) };
}
function secretOfDraft(draft: SshServerDraft, old?: StoredSshServer): StoredSshServer["secret"] {
  if (draft.auth.kind === "auto") return old?.auth === "auto" ? old.secret : {};
  if (draft.auth.kind === "password") return draft.auth.password ? { password: draft.auth.password } : old?.secret || {};
  return { privateKey: fs.readFileSync(draft.auth.keyPath, "utf8"), ...(draft.auth.passphrase ? { passphrase: draft.auth.passphrase } : {}) };
}
function credentialOfStored(server: StoredSshServer): SshCredential {
  if (server.auth === "password") { if (!server.secret.password) throw new Error(`${server.name} 의 저장된 비밀번호가 없습니다`); return { kind: "password", password: server.secret.password }; }
  if (!server.secret.privateKey) throw new Error(`${server.name} 의 저장된 키가 없습니다`);
  return { kind: "key", privateKey: server.secret.privateKey, ...(server.secret.passphrase ? { passphrase: server.secret.passphrase } : {}) };
}
function draftFromStored(server: StoredSshServer): SshServerDraft {
  return {
    originalName: server.name,
    name: server.name,
    host: server.host,
    port: server.port,
    user: server.user,
    auth: server.auth === "auto"
      ? { kind: "auto" }
      : server.auth === "password"
        ? { kind: "password", password: server.secret.password }
        : { kind: "key", keyPath: "" },
  };
}
function problemOf(error: unknown): SshRemotePathProblem {
  if (error instanceof SshTransportError && ["auth-failed", "fingerprint-changed", "unreachable"].includes(error.kind)) return error.kind as SshRemotePathProblem;
  return "unreachable";
}

function remoteBrowseFailure(remotePath: string, error: unknown): SshRemoteDirectoryResult {
  const problem: SshRemoteBrowseProblem = error instanceof SshRemoteFileError
    ? error.kind
    : error instanceof SshTransportError && ["auth-failed", "fingerprint-changed", "unreachable"].includes(error.kind)
      ? error.kind as SshRemoteBrowseProblem
      : "read-failed";
  const detail = messageOf(error).trim();
  log(problem === "missing" ? "warn" : "error", "ssh", "Remote SSH folder could not be read", {
    path: remotePath,
    problem,
    ...(detail ? { detail } : {}),
  });
  return { ok: false, path: remotePath, problem, ...(detail ? { detail } : {}) };
}

function sshKeygenExecutable(): string {
  if (process.platform !== "win32") return "ssh-keygen";
  const windowsDir = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const bundled = path.join(windowsDir, "System32", "OpenSSH", "ssh-keygen.exe");
  return fs.existsSync(bundled) ? bundled : "ssh-keygen";
}

function privateKeyIsLocked(text: string): boolean | undefined {
  const openSsh = /-----BEGIN OPENSSH PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (openSsh) {
    const payload = Buffer.from(openSsh[1].replace(/\s/g, ""), "base64");
    const magic = Buffer.from("openssh-key-v1\0", "ascii");
    if (payload.length < magic.length + 4 || !payload.subarray(0, magic.length).equals(magic)) return undefined;
    const cipherLength = payload.readUInt32BE(magic.length);
    const cipherStart = magic.length + 4;
    const cipherEnd = cipherStart + cipherLength;
    return cipherEnd <= payload.length ? payload.toString("ascii", cipherStart, cipherEnd) !== "none" : undefined;
  }
  return /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)
    || /Proc-Type:\s*4,ENCRYPTED/i.test(text)
    || /DEK-Info:/i.test(text);
}

function keyPassphraseMatches(keyPath: string, passphrase: string | undefined): boolean {
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8");
  } catch {
    // File inspection reports unreadable paths separately. Do not mislabel a
    // filesystem failure as an incorrect passphrase at submit time.
    return true;
  }
  if (privateKeyIsLocked(privateKey) !== true) return true;
  return !(sshUtils.parseKey(privateKey, passphrase) instanceof Error);
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }

function attemptFailureDetail(kind: import("../../shared/sshServers").SshAttemptErrorKind, error: unknown): string | undefined {
  // `kind` owns the localized UI title. Detail is only the underlying SSH or
  // remote-command text, so the renderer never repeats the same sentence.
  if (kind === "password-not-allowed" || kind === "fingerprint-changed") return undefined;
  return messageOf(error).trim() || undefined;
}

function forgetDraftSecrets(draft: SshServerDraft): void {
  if (draft.auth.kind === "password") draft.auth = { kind: "password" };
  else if (draft.auth.kind === "key") draft.auth = { kind: "key", keyPath: "" };
}
