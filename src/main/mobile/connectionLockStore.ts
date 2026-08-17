import * as fs from "node:fs";
import * as path from "node:path";
import { sodium, sodiumReady, type ConnectionLockKind, type CtlLock } from "@agentparty/protocol";
import type { MobileGatewayDeps, SecretCipher } from "./index";

const LOCK_FILE = "mobile-connection-lock.json";
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 30 * 60_000;

interface LockFile {
  v: 1;
  encrypted: boolean;
  payload: string;
}

interface LockPayload {
  lock: { kind: ConnectionLockKind; verifier: string } | null;
  failures: Record<string, { attempts: number; lockedUntil: number | null }>;
}

export interface ConnectionLockStatus {
  configured: boolean;
  kind: ConnectionLockKind | null;
}

export interface UnlockResult {
  unlocked: boolean;
  state: CtlLock;
}

export interface ConnectionLockStoreDeps {
  userDataPath: string;
  secretCipher: SecretCipher;
  log: MobileGatewayDeps["log"];
  onSecurityWarning: MobileGatewayDeps["onSecurityWarning"];
  now?: () => number;
}

/**
 * Desktop-owned connection-lock verifier and per-device failure ledger.
 *
 * The phone never receives the verifier, and the desktop never stores the
 * submitted PIN/pattern. The verifier is still encrypted with the OS keychain
 * because a six-digit secret is cheap to brute-force if its hash is stolen.
 */
export class ConnectionLockStore {
  private payload: LockPayload = { lock: null, failures: {} };
  private readonly now: () => number;

  private constructor(private readonly deps: ConnectionLockStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  static async open(deps: ConnectionLockStoreDeps): Promise<ConnectionLockStore> {
    await sodiumReady();
    const store = new ConnectionLockStore(deps);
    store.load();
    return store;
  }

  status(): ConnectionLockStatus {
    return { configured: this.payload.lock !== null, kind: this.payload.lock?.kind ?? null };
  }

  configure(kind: ConnectionLockKind, secret: string): void {
    assertSecret(kind, secret);
    const input = domainSeparated(kind, secret);
    const s = sodium();
    const verifier = s.crypto_pwhash_str(
      input,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    );
    this.payload = { lock: { kind, verifier }, failures: {} };
    this.save();
    this.deps.log("info", "mobile connection lock configured", { kind });
  }

  clear(): void {
    this.payload = { lock: null, failures: {} };
    this.save();
    this.deps.log("info", "mobile connection lock cleared");
  }

  forgetDevice(deviceId: string): void {
    if (delete this.payload.failures[deviceId]) {
      this.save();
    }
  }

  stateFor(deviceId: string): CtlLock {
    const lock = this.payload.lock;
    if (!lock) {
      return unlockedState();
    }
    const failure = this.normalizedFailure(deviceId);
    if (failure.lockedUntil !== null) {
      return {
        k: "ctl",
        c: "lock",
        required: true,
        kind: lock.kind,
        attemptsLeft: 0,
        lockedUntil: failure.lockedUntil,
        error: "locked_out",
      };
    }
    return {
      k: "ctl",
      c: "lock",
      required: true,
      kind: lock.kind,
      attemptsLeft: MAX_ATTEMPTS - failure.attempts,
      lockedUntil: null,
    };
  }

  verify(deviceId: string, secret: string): UnlockResult {
    const lock = this.payload.lock;
    if (!lock) {
      return { unlocked: true, state: unlockedState() };
    }

    const failure = this.normalizedFailure(deviceId);
    if (failure.lockedUntil !== null) {
      return { unlocked: false, state: this.stateFor(deviceId) };
    }

    let validShape = true;
    try {
      assertSecret(lock.kind, secret);
    } catch {
      validShape = false;
    }
    const verified =
      validShape && sodium().crypto_pwhash_str_verify(lock.verifier, domainSeparated(lock.kind, secret));
    if (verified) {
      if (this.payload.failures[deviceId]) {
        delete this.payload.failures[deviceId];
        this.save();
      }
      this.deps.log("info", "mobile connection unlock accepted", { deviceId, attemptsLeft: MAX_ATTEMPTS });
      return { unlocked: true, state: this.stateFor(deviceId) };
    }

    const attempts = failure.attempts + 1;
    const lockedUntil = attempts >= MAX_ATTEMPTS ? this.now() + LOCKOUT_MS : null;
    this.payload.failures[deviceId] = { attempts, lockedUntil };
    this.save();
    const state: CtlLock = {
      k: "ctl",
      c: "lock",
      required: true,
      kind: lock.kind,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
      lockedUntil,
      error: lockedUntil === null ? "bad_secret" : "locked_out",
    };
    this.deps.log("warn", "mobile connection unlock rejected", {
      deviceId,
      attemptsLeft: state.attemptsLeft,
      lockedUntil,
    });
    return { unlocked: false, state };
  }

  private normalizedFailure(deviceId: string): { attempts: number; lockedUntil: number | null } {
    const failure = this.payload.failures[deviceId];
    if (!failure) {
      return { attempts: 0, lockedUntil: null };
    }
    if (failure.lockedUntil !== null && failure.lockedUntil <= this.now()) {
      delete this.payload.failures[deviceId];
      this.save();
      return { attempts: 0, lockedUntil: null };
    }
    return failure;
  }

  private load(): void {
    const file = path.join(this.deps.userDataPath, LOCK_FILE);
    if (!fs.existsSync(file)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
    if (parsed.v !== 1) {
      throw new Error(`mobile connection lock: unsupported file version ${parsed.v} in ${file}`);
    }
    const raw = Buffer.from(parsed.payload, "base64");
    let plaintext: string;
    try {
      plaintext = parsed.encrypted ? this.deps.secretCipher.decryptString(raw) : raw.toString("utf8");
    } catch (error) {
      throw new Error(`mobile connection lock: ${file} could not be decrypted (${String(error)})`);
    }
    const payload = JSON.parse(plaintext) as LockPayload;
    validatePayload(payload);
    this.payload = payload;
  }

  private save(): void {
    const available = this.deps.secretCipher.isEncryptionAvailable();
    if (!available && this.payload.lock !== null) {
      this.deps.onSecurityWarning({
        code: "connection_lock_verifier_unencrypted",
        message:
          "운영체제 보안 저장소를 사용할 수 없어 연결 잠금 검증값을 암호화하지 못했습니다. " +
          "이 PC의 앱 데이터에 접근한 공격자는 PIN 또는 패턴을 오프라인으로 추측할 수 있습니다.",
      });
      this.deps.log("warn", "mobile connection lock verifier stored unencrypted", {
        file: path.join(this.deps.userDataPath, LOCK_FILE),
      });
    }
    const plaintext = JSON.stringify(this.payload);
    const payload = available
      ? this.deps.secretCipher.encryptString(plaintext).toString("base64")
      : Buffer.from(plaintext, "utf8").toString("base64");
    const contents: LockFile = { v: 1, encrypted: available, payload };
    writeFileAtomic(path.join(this.deps.userDataPath, LOCK_FILE), JSON.stringify(contents, null, 2));
  }
}

function unlockedState(): CtlLock {
  return {
    k: "ctl",
    c: "lock",
    required: false,
    kind: null,
    attemptsLeft: MAX_ATTEMPTS,
    lockedUntil: null,
  };
}

function domainSeparated(kind: ConnectionLockKind, secret: string): string {
  return `${kind}\0${secret}`;
}

export function assertSecret(kind: ConnectionLockKind, secret: string): void {
  if (kind === "pin") {
    if (!/^\d{6}$/.test(secret)) {
      throw new Error("PIN은 숫자 6자리여야 합니다.");
    }
    return;
  }
  if (!/^[0-8]{6,9}$/.test(secret) || new Set(secret).size !== secret.length) {
    throw new Error("패턴은 3×3 점 중 서로 다른 6~9개를 이어야 합니다.");
  }
}

function validatePayload(payload: LockPayload): void {
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.failures ||
    typeof payload.failures !== "object" ||
    Array.isArray(payload.failures)
  ) {
    throw new Error("mobile connection lock: corrupt payload");
  }
  if (payload.lock !== null) {
    if (
      !payload.lock ||
      (payload.lock.kind !== "pin" && payload.lock.kind !== "pattern") ||
      typeof payload.lock.verifier !== "string"
    ) {
      throw new Error("mobile connection lock: corrupt verifier record");
    }
  } else if (Object.keys(payload.failures).length !== 0) {
    throw new Error("mobile connection lock: failure ledger exists without a lock");
  }
  for (const [deviceId, failure] of Object.entries(payload.failures)) {
    if (
      !failure ||
      typeof failure !== "object" ||
      deviceId.length === 0 ||
      !Number.isInteger(failure.attempts) ||
      failure.attempts < 1 ||
      failure.attempts > MAX_ATTEMPTS ||
      (failure.lockedUntil !== null && (!Number.isSafeInteger(failure.lockedUntil) || failure.lockedUntil < 0)) ||
      (failure.attempts < MAX_ATTEMPTS && failure.lockedUntil !== null) ||
      (failure.attempts === MAX_ATTEMPTS && failure.lockedUntil === null)
    ) {
      throw new Error("mobile connection lock: corrupt failure ledger");
    }
  }
}

function writeFileAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}
