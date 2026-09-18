import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

export interface SshTarget { host: string; port: number; user: string }
export type SshCredential = { kind: "password"; password: string } | { kind: "key"; privateKey: string; passphrase?: string };

export interface SshCommandResult { code: number; stdout: string; stderr: string }
export interface SshDirectoryEntry { name: string; path: string; hidden: boolean }
export interface SshDirectoryListing { path: string; entries: SshDirectoryEntry[]; truncated: boolean }

export interface SshTransportConnection {
  exec(command: string): Promise<SshCommandResult>;
  openProcess(command: string): Promise<Duplex & { stderr: Duplex }>;
  upload(localPath: string, remotePath: string): Promise<void>;
  homeDirectory(): Promise<string>;
  listDirectories(remotePath: string, limit: number): Promise<SshDirectoryListing>;
  dispose(): void;
}

export type SshTransportFailureKind = "unreachable" | "auth-failed" | "key-rejected" | "password-not-allowed" | "fingerprint-changed";

export class SshTransportError extends Error {
  constructor(readonly kind: SshTransportFailureKind, message: string, readonly fingerprint?: string) {
    super(message);
    this.name = "SshTransportError";
  }
}

export type SshRemoteFileFailureKind = "permission-denied" | "missing" | "read-failed";

export class SshRemoteFileError extends Error {
  constructor(readonly kind: SshRemoteFileFailureKind, message: string) {
    super(message);
    this.name = "SshRemoteFileError";
  }
}

/** Network implementation boundary. The production implementation uses ssh2. */
export abstract class SshTransport extends EventEmitter {
  abstract fingerprint(target: SshTarget): Promise<string>;
  abstract connect(serverName: string, target: SshTarget, credential: SshCredential, expectedFingerprint: string): Promise<SshTransportConnection>;
  abstract disconnect(serverName: string): void;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
