import * as fs from "node:fs";
import * as path from "node:path";
import type { SshAuthKind, SshTestResult } from "../../shared/sshServers";

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface StoredSshServer {
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuthKind;
  keyFileName?: string;
  hostFingerprint: string;
  secret: { password?: string; privateKey?: string; passphrase?: string };
  autoLoginPublicKey?: string;
  lastTest?: SshTestResult;
}

interface DiskServer extends Omit<StoredSshServer, "secret"> {
  secret: string;
}

interface DiskState { version: 1; servers: DiskServer[]; autoLoginIdentity?: { privateKey: string; publicKey: string } }

/** App-owned SSH credentials. Secret payloads are always OS-encrypted at rest. */
export class SshServerStore {
  private readonly file: string;

  constructor(userDataDir: string, private readonly cipher: SecretCipher) {
    this.file = path.join(userDataDir, "ssh-servers.json");
  }

  list(): StoredSshServer[] {
    return this.read().servers.map((server) => ({
      ...server,
      secret: this.decrypt(server.name, server.secret),
    }));
  }

  get(name: string): StoredSshServer | undefined {
    return this.list().find((server) => server.name === name);
  }

  save(server: StoredSshServer, originalName?: string): void {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error(`SSH server '${server.name}' cannot be saved because operating-system credential encryption is unavailable.`);
    }
    const state = this.read();
    const identity = originalName || server.name;
    const duplicate = state.servers.find((entry) => entry.name === server.name && entry.name !== identity);
    if (duplicate) throw new Error(`SSH server '${server.name}' already exists.`);
    const next: DiskServer = {
      ...server,
      secret: this.cipher.encryptString(JSON.stringify(server.secret)).toString("base64"),
    };
    const index = state.servers.findIndex((entry) => entry.name === identity);
    if (index >= 0) state.servers[index] = next;
    else state.servers.push(next);
    this.write(state);
  }

  delete(name: string): boolean {
    const state = this.read();
    const servers = state.servers.filter((server) => server.name !== name);
    if (servers.length === state.servers.length) return false;
    this.write({ ...state, servers });
    return true;
  }

  autoLoginIdentity(create: () => { privateKey: string; publicKey: string }): { privateKey: string; publicKey: string } {
    const state = this.read();
    if (state.autoLoginIdentity) {
      return {
        privateKey: this.cipher.decryptString(Buffer.from(state.autoLoginIdentity.privateKey, "base64")),
        publicKey: state.autoLoginIdentity.publicKey,
      };
    }
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error("The automatic-login key cannot be created because operating-system credential encryption is unavailable.");
    }
    const identity = create();
    state.autoLoginIdentity = {
      privateKey: this.cipher.encryptString(identity.privateKey).toString("base64"),
      publicKey: identity.publicKey,
    };
    this.write(state);
    return identity;
  }

  private decrypt(name: string, encoded: string): StoredSshServer["secret"] {
    try {
      return JSON.parse(this.cipher.decryptString(Buffer.from(encoded, "base64")));
    } catch (error) {
      throw new Error(`Stored credentials for SSH server '${name}' could not be decrypted: ${messageOf(error)}`);
    }
  }

  private read(): DiskState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<DiskState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.servers)) {
        throw new Error("unsupported SSH server store format");
      }
      return { version: 1, servers: parsed.servers, ...(parsed.autoLoginIdentity ? { autoLoginIdentity: parsed.autoLoginIdentity } : {}) };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { version: 1, servers: [] };
      throw new Error(`SSH server settings could not be read from '${this.file}': ${messageOf(error)}`);
    }
  }

  private write(state: DiskState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
