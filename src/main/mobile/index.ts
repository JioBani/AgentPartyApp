import type { MobileSettings } from "../../shared/mobileProtocol";
import type { MobileGateway } from "./mobileGateway";
import { createMockMobileGateway, type MockMobileGateway, type MockMobileGatewayOptions } from "./mockMobileGateway";

export type { MobileGateway } from "./mobileGateway";
export type {
  MobileEventScope,
  MobileGatewayStartOptions,
  MobilePairingApi,
  MobilePushApi,
  MobileRequestHandler,
  MobileSnapshotProvider,
  PairingSession,
  PushPayload,
  RequestContext,
  SnapshotContext,
} from "./mobileGateway";
export { createMockMobileGateway } from "./mockMobileGateway";
export type { MockControls, MockMobileGateway, MockMobileGatewayOptions } from "./mockMobileGateway";

/**
 * Everything the real pipe needs from the host app. Kept to primitives and
 * narrow function types so `src/main/mobile/` stays testable without Electron
 * and portable across Windows/macOS/Linux (06 §데스크톱).
 */
export interface MobileGatewayDeps {
  /** Directory for the identity blob and trust store (Electron `userData`). */
  userDataPath: string;
  /**
   * OS keychain wrapper, normally Electron's `safeStorage`. When encryption is
   * unavailable (a Linux box with no libsecret/kwallet), the pipe stores the
   * identity unencrypted **and** reports it through `onSecurityWarning` — it
   * does not fail silently and does not pretend to be encrypted (06).
   */
  secretCipher: SecretCipher;
  /** Structured logger; the pipe never writes to the console directly. */
  log: (level: "debug" | "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
  /** Surfaces a degraded-security condition to the user (AGENTS.md). */
  onSecurityWarning: (warning: { code: string; message: string }) => void;
  /** Persisted settings, owned by the app's settings store. */
  readSettings: () => MobileSettings;
  writeSettings: (settings: MobileSettings) => void;
  /** Default `deviceName` when the user has not set one (e.g. the hostname). */
  defaultDeviceName: string;
  /** App version reported in `sys.info`. */
  appVersion: string;
}

/**
 * Structurally identical to Electron's `safeStorage`, so it can be passed
 * straight through. The API is string-oriented, so the pipe base64-encodes key
 * bytes before handing them over rather than inventing a Buffer variant that
 * the platform does not offer.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface CreateMobileGatewayOptions {
  /**
   * `"mock"` selects the in-memory simulator. There is no automatic fallback:
   * asking for `"real"` and getting a mock would hide a broken pipe behind a
   * UI that looks connected.
   */
  implementation: "real" | "mock";
  deps?: MobileGatewayDeps;
  /**
   * Seeds the mock's settings and fixtures at construction, so the caller does
   * not have to follow `createMobileGateway` with an `updateSettings()` call
   * that the real gateway would not need (it reads {@link
   * MobileGatewayDeps.readSettings} itself). Ignored by the real gateway.
   */
  mock?: MockMobileGatewayOptions;
}

/**
 * Single construction point for the mobile pipe.
 *
 * @throws when `implementation: "real"` is requested before the real gateway
 *   ships, or when its dependencies are missing.
 */
export function createMobileGateway(options: CreateMobileGatewayOptions): MobileGateway | MockMobileGateway {
  if (options.implementation === "mock") {
    return createMockMobileGateway(options.mock);
  }
  if (!options.deps) {
    throw new Error("createMobileGateway: the real gateway requires MobileGatewayDeps");
  }
  throw new Error(
    "createMobileGateway: the real mobile gateway is not implemented yet (desktop-pipe M1). " +
      'Use implementation: "mock" until it lands.',
  );
}
