import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { SshTransport, SshTransportError, type SshCommandResult, type SshCredential, type SshTarget, type SshTransportConnection } from "./sshTransport";

// ssh2 has no runtime dependency on Electron and supports password/key auth
// without putting secrets in argv or environment variables.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require("ssh2") as { Client: new () => any };

interface LiveConnection { client: any; target: SshTarget; wrapper: Ssh2Connection; closed: boolean }

export class Ssh2Transport extends SshTransport {
  private readonly live = new Map<string, LiveConnection>();
  private readonly pending = new Map<string, any>();
  private readonly cancelledPending = new WeakSet<object>();

  async fingerprint(target: SshTarget): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const finish = (error?: unknown, value?: string) => {
        if (settled) return;
        settled = true;
        client.end();
        error ? reject(classify(error)) : resolve(value!);
      };
      client.on("error", (error: unknown) => { if (!settled) finish(error); });
      client.connect({
        host: target.host, port: target.port, username: target.user,
        readyTimeout: 10_000,
        hostVerifier: (key: Buffer | string) => {
          finish(undefined, fingerprintOf(key));
          return false;
        },
        // Intentionally unusable: discovery ends at the host key and never
        // attempts a real account login.
        password: `fingerprint-only-${Date.now()}`,
      });
    });
  }

  async connect(serverName: string, target: SshTarget, credential: SshCredential, expectedFingerprint: string): Promise<SshTransportConnection> {
    const existing = this.live.get(serverName);
    if (existing && existing.target.host === target.host && existing.target.port === target.port && existing.target.user === target.user && !existing.closed) {
      return existing.wrapper;
    }
    this.disconnect(serverName);
    this.emit("state", { server: serverName, connection: "connecting" });
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.pending.set(serverName, client);
      let actualFingerprint = "";
      let attemptedCredential = false;
      let passwordNotAllowed = false;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (this.pending.get(serverName) === client) this.pending.delete(serverName);
        client.end();
        if (this.cancelledPending.delete(client)) {
          reject(new SshTransportError("unreachable", `${serverName} 연결을 취소했습니다`));
          return;
        }
        const classified = actualFingerprint && actualFingerprint !== expectedFingerprint
          ? new SshTransportError("fingerprint-changed", `${serverName} 지문이 바뀌었습니다`, actualFingerprint)
          : passwordNotAllowed
            ? new SshTransportError("password-not-allowed", `${serverName} 에서 비밀번호 로그인을 사용할 수 없습니다`)
          : classify(error, credential.kind);
        this.emit("state", {
          server: serverName,
          connection: ["auth-failed", "key-rejected", "password-not-allowed"].includes(classified.kind)
            ? "auth-failed"
            : classified.kind,
        });
        reject(classified);
      };
      client.once("ready", () => {
        if (settled) return;
        settled = true;
        if (this.pending.get(serverName) === client) this.pending.delete(serverName);
        client.removeListener("error", fail);
        client.removeListener("close", closedBeforeReady);
        const wrapper = new Ssh2Connection(client);
        const live: LiveConnection = { client, target, wrapper, closed: false };
        this.live.set(serverName, live);
        client.on("close", () => {
          if (live.closed) return;
          this.live.delete(serverName);
          this.emit("state", { server: serverName, connection: "disconnected" });
        });
        client.on("error", (error: unknown) => {
          if (!live.closed) this.emit("state", { server: serverName, connection: classify(error).kind });
        });
        this.emit("state", { server: serverName, connection: "connected" });
        resolve(wrapper);
      });
      const closedBeforeReady = () => fail(new Error(`${serverName} 로그인 전에 연결이 끊겼습니다`));
      client.once("error", fail);
      client.once("close", closedBeforeReady);
      const config = {
        host: target.host, port: target.port, username: target.user, readyTimeout: 12_000,
        keepaliveInterval: 10_000, keepaliveCountMax: 3,
        authHandler: (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (method: string | false) => void) => {
          if (methodsLeft === null) { callback("none"); return; }
          const method = credential.kind === "password" ? "password" : "publickey";
          if (!methodsLeft.includes(method)) {
            if (credential.kind === "password") passwordNotAllowed = true;
            callback(false);
            return;
          }
          if (attemptedCredential) { callback(false); return; }
          attemptedCredential = true;
          callback(method);
        },
        hostVerifier: (key: Buffer | string) => {
          actualFingerprint = fingerprintOf(key);
          return actualFingerprint === expectedFingerprint;
        },
        ...(credential.kind === "password"
          ? { password: credential.password }
          : { privateKey: credential.privateKey, ...(credential.passphrase ? { passphrase: credential.passphrase } : {}) }),
      };
      try { client.connect(config); } catch (error) { fail(error); }
    });
  }

  disconnect(serverName: string): void {
    const pending = this.pending.get(serverName);
    if (pending) {
      this.pending.delete(serverName);
      this.cancelledPending.add(pending);
      pending.end();
    }
    const live = this.live.get(serverName);
    if (!live) {
      if (pending) this.emit("state", { server: serverName, connection: "disconnected" });
      return;
    }
    live.closed = true;
    this.live.delete(serverName);
    live.client.end();
    this.emit("state", { server: serverName, connection: "disconnected" });
  }
}

class Ssh2Connection implements SshTransportConnection {
  constructor(readonly client: any) {}

  exec(command: string): Promise<SshCommandResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error: unknown, stream: Duplex & { stderr: Duplex }) => {
        if (error) { reject(classify(error)); return; }
        let stdout = "";
        let stderr = "";
        stream.setEncoding("utf8");
        stream.stderr.setEncoding("utf8");
        stream.on("data", (chunk) => { stdout += String(chunk); });
        stream.stderr.on("data", (chunk) => { stderr += String(chunk); });
        stream.once("error", reject);
        stream.once("close", (code: number) => resolve({ code: Number(code ?? 0), stdout, stderr }));
      });
    });
  }

  openProcess(command: string): Promise<Duplex & { stderr: Duplex }> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error: unknown, stream: Duplex & { stderr: Duplex }) => error ? reject(classify(error)) : resolve(stream));
    });
  }

  upload(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error: unknown, sftp: any) => {
        if (error) { reject(classify(error)); return; }
        sftp.fastPut(localPath, remotePath, (putError: unknown) => {
          sftp.end();
          putError ? reject(classify(putError)) : resolve();
        });
      });
    });
  }

  dispose(): void { this.client.end(); }
}

function fingerprintOf(key: Buffer | string): string {
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key, "hex");
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

function classify(error: unknown, credential?: SshCredential["kind"]): SshTransportError {
  const message = error instanceof Error ? error.message : String(error);
  if (credential === "key" && /privatekey|private key|passphrase|encrypted.*key|key format/i.test(message)) {
    return new SshTransportError("key-rejected", message);
  }
  if (/all configured authentication methods failed|authentication failure|permission denied/i.test(message)) {
    return new SshTransportError(credential === "key" ? "key-rejected" : "auth-failed", message);
  }
  if (/timed out|econnrefused|ehostunreach|enotfound|connection lost|not connected/i.test(message)) {
    return new SshTransportError("unreachable", message);
  }
  return new SshTransportError("unreachable", message);
}
