import * as fs from "node:fs";
import * as path from "node:path";
import {
  SEED_BYTES,
  deviceIdOf,
  fromB64,
  identityFromSeeds,
  randomBytes,
  sodiumReady,
  toB64,
  type Identity,
  type PublicIdentity,
} from "@agentparty/protocol";
import type { MobilePlatform, TrustedDevice } from "../../shared/mobileProtocol";
import type { MobileGatewayDeps, SecretCipher } from "./index";

/**
 * This desktop's long-lived identity and its list of trusted phones
 * (01 §1, §2.3).
 *
 * Two files, because they have different secrecy needs:
 *
 * - `mobile-identity.json` holds the Ed25519 and X25519 SECRET keys, encrypted
 *   with the OS keychain through {@link SecretCipher}. Losing these means
 *   re-pairing every phone; leaking them means someone can impersonate this
 *   desktop, which is the highest-value asset in the threat model (02 §자산).
 * - `mobile-devices.json` holds trust records, which are public keys and names.
 *   It is stored in the clear: encrypting it would suggest a confidentiality
 *   guarantee that does not exist (anyone who can write this file can already
 *   write the app's own data directory).
 *
 * When the OS offers no encryption — a Linux box without libsecret/kwallet —
 * the identity is written unencrypted, the file records `encrypted: false`, and
 * the user is warned. Silently degrading, or silently refusing to start, are
 * both worse than saying so (AGENTS.md, 06 §데스크톱).
 */

const IDENTITY_FILE = "mobile-identity.json";
const DEVICES_FILE = "mobile-devices.json";

/** On-disk shape. `v` guards against a future format change. */
interface IdentityFile {
  v: 1;
  encrypted: boolean;
  /** base64url of the 32-byte Ed25519 seed and the 32-byte X25519 seed. */
  payload: string;
}

interface DevicesFile {
  v: 1;
  /** 01 §2.3 — raised on every revoke so a stale `hello` is refused. */
  trustEpoch: number;
  devices: TrustedDevice[];
}

export interface IdentityStoreDeps {
  userDataPath: string;
  secretCipher: SecretCipher;
  log: MobileGatewayDeps["log"];
  onSecurityWarning: MobileGatewayDeps["onSecurityWarning"];
}

export class IdentityStore {
  private devicesById = new Map<string, TrustedDevice>();
  private epoch = 1;

  private constructor(
    readonly identity: Identity,
    private readonly deps: IdentityStoreDeps,
  ) {}

  /**
   * Loads the identity, generating one on first run.
   *
   * @throws when an existing identity file cannot be read or decrypted. A
   *   corrupt or undecryptable identity is NOT replaced with a fresh one:
   *   that would silently unpair every phone and look like a protocol bug.
   */
  static async open(deps: IdentityStoreDeps): Promise<IdentityStore> {
    await sodiumReady();
    const identityPath = path.join(deps.userDataPath, IDENTITY_FILE);
    const identity = fs.existsSync(identityPath)
      ? readIdentity(identityPath, deps)
      : createIdentity(identityPath, deps);
    const store = new IdentityStore(identity, deps);
    store.loadDevices();
    return store;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  /** Public half, safe to put in a QR or a trust record. */
  get publicIdentity(): PublicIdentity {
    return { deviceId: this.identity.deviceId, sigPk: this.identity.sigPk, kxPk: this.identity.kxPk };
  }

  get trustEpoch(): number {
    return this.epoch;
  }

  devices(): TrustedDevice[] {
    return [...this.devicesById.values()];
  }

  find(deviceId: string): TrustedDevice | undefined {
    return this.devicesById.get(deviceId);
  }

  /**
   * Resolves the trust record for an incoming peer and checks its `epoch`
   * against the current one (01 §2.3).
   *
   * @throws when the device is unknown or its epoch is stale — the caller must
   *   refuse the connection rather than treat it as a new pairing.
   */
  requireTrusted(deviceId: string, epoch: number): TrustedDevice {
    const device = this.devicesById.get(deviceId);
    if (!device) {
      throw new Error(`mobile identity: ${deviceId} is not a paired device`);
    }
    if (epoch < device.epoch) {
      throw new Error(
        `mobile identity: ${deviceId} presented trust epoch ${epoch}, current is ${device.epoch} — re-pairing required`,
      );
    }
    return device;
  }

  addDevice(device: TrustedDevice): void {
    if (deviceIdOf(fromB64(device.sigPk)) !== device.deviceId) {
      throw new Error(`mobile identity: ${device.deviceId} does not match its own signing key`);
    }
    this.devicesById.set(device.deviceId, device);
    this.saveDevices();
  }

  /** Forgets a phone and raises `trustEpoch` so its old `hello` is refused. */
  revokeDevice(deviceId: string): void {
    if (!this.devicesById.delete(deviceId)) {
      throw new Error(`mobile identity: ${deviceId} is not a paired device`);
    }
    this.epoch += 1;
    this.saveDevices();
  }

  renameDevice(deviceId: string, name: string): void {
    this.saveDevice(deviceId, (device) => ({ ...device, name }));
  }

  touch(deviceId: string, at: number): void {
    this.saveDevice(deviceId, (device) => ({ ...device, lastSeenAt: at }));
  }

  setPushHandle(deviceId: string, platform: MobilePlatform, handle: string, at: number): void {
    this.saveDevice(deviceId, (device) => ({ ...device, push: { platform, handle, registeredAt: at } }));
  }

  // -- internals ------------------------------------------------------------

  private saveDevice(deviceId: string, update: (device: TrustedDevice) => TrustedDevice): void {
    const device = this.devicesById.get(deviceId);
    if (!device) {
      throw new Error(`mobile identity: ${deviceId} is not a paired device`);
    }
    this.devicesById.set(deviceId, update(device));
    this.saveDevices();
  }

  private loadDevices(): void {
    const file = path.join(this.deps.userDataPath, DEVICES_FILE);
    if (!fs.existsSync(file)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DevicesFile;
    if (parsed.v !== 1) {
      throw new Error(`mobile identity: unsupported trust store version ${parsed.v} in ${file}`);
    }
    this.epoch = parsed.trustEpoch;
    this.devicesById = new Map(parsed.devices.map((device) => [device.deviceId, device]));
  }

  private saveDevices(): void {
    const file: DevicesFile = { v: 1, trustEpoch: this.epoch, devices: this.devices() };
    writeFileAtomic(path.join(this.deps.userDataPath, DEVICES_FILE), JSON.stringify(file, null, 2));
  }
}

/**
 * The identity is stored as its two 32-byte SEEDS rather than the expanded key
 * pairs: `identityFromSeeds` regenerates the exact same keys, the file is
 * smaller, and there is only one representation to get right.
 */
function serializeIdentity(sigSeed: Uint8Array, kxSeed: Uint8Array): string {
  return JSON.stringify({ sigSeed: toB64(sigSeed), kxSeed: toB64(kxSeed) });
}

/**
 * Built from fresh random seeds rather than `generateIdentity()`, which does
 * not expose the seeds it used. Storing seeds keeps load and create on exactly
 * one derivation path, so a key that round-trips through disk is provably the
 * same key.
 */
function createIdentity(file: string, deps: IdentityStoreDeps): Identity {
  const sigSeed = randomBytes(SEED_BYTES);
  const kxSeed = randomBytes(SEED_BYTES);
  const identity = identityFromSeeds(sigSeed, kxSeed);
  persistIdentity(file, serializeIdentity(sigSeed, kxSeed), deps);
  deps.log("info", "mobile identity created", { deviceId: identity.deviceId });
  return identity;
}

function persistIdentity(file: string, plaintext: string, deps: IdentityStoreDeps): void {
  const available = deps.secretCipher.isEncryptionAvailable();
  if (!available) {
    deps.onSecurityWarning({
      code: "identity_unencrypted",
      message:
        "OS 키체인을 쓸 수 없어 모바일 신원키를 암호화하지 않고 저장합니다. " +
        "이 PC에 접근할 수 있는 사람이 페어링된 폰 행세를 할 수 있습니다.",
    });
    deps.log("warn", "mobile identity stored unencrypted", { file });
  }
  const payload = available ? deps.secretCipher.encryptString(plaintext).toString("base64") : Buffer.from(plaintext, "utf8").toString("base64");
  const contents: IdentityFile = { v: 1, encrypted: available, payload };
  writeFileAtomic(file, JSON.stringify(contents, null, 2));
}

function readIdentity(file: string, deps: IdentityStoreDeps): Identity {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as IdentityFile;
  if (parsed.v !== 1) {
    throw new Error(`mobile identity: unsupported identity file version ${parsed.v} in ${file}`);
  }
  const raw = Buffer.from(parsed.payload, "base64");
  let plaintext: string;
  try {
    plaintext = parsed.encrypted ? deps.secretCipher.decryptString(raw) : raw.toString("utf8");
  } catch (error) {
    // Typically a different OS user or a restored profile. Recreating the
    // identity here would unpair every phone without telling anyone why.
    throw new Error(
      `mobile identity: ${file} could not be decrypted (${String(error)}). ` +
        "Delete it to start over — every paired phone will need to pair again.",
    );
  }
  const { sigSeed, kxSeed } = JSON.parse(plaintext) as { sigSeed: string; kxSeed: string };
  return identityFromSeeds(fromB64(sigSeed), fromB64(kxSeed));
}

function writeFileAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}
