import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import extractZip from "extract-zip";
import {
  getSubscriptionProxyStatus,
  subscriptionProxyConfig,
  type SubscriptionProxyAuthenticationStatus,
  type SubscriptionProxyProvider,
  type SubscriptionProxyStatus,
} from "../core/subscriptionProxy";
import { DEFAULT_SUBSCRIPTION_PROXY_BASE_URL } from "../shared/subscriptionProxyDefaults";
import { log } from "./logger";

export interface SubscriptionProxyLoginResult {
  ok: boolean;
  provider: SubscriptionProxyProvider;
  status: "already_available" | "started" | "pending" | "error";
  detail: string;
  subscriptions: SubscriptionProxyStatus;
}

/** Application-layer dependency used by AppController and easy to fake in QA. */
export interface SubscriptionProxyController {
  getStatus(): Promise<SubscriptionProxyStatus>;
  login(provider: SubscriptionProxyProvider): Promise<SubscriptionProxyLoginResult>;
}

interface LoginState extends SubscriptionProxyAuthenticationStatus {
  startedAt: number;
}

/**
 * Owns the local subscription bridge lifecycle for the desktop process.
 *
 * OAuth credentials remain in CLIProxyAPI's normal persistent auth directory,
 * while the bridge itself is automatically started on every app launch and
 * monitored afterwards. The detached bridge intentionally survives an app
 * window restart, so a previously authenticated user never has to run a helper
 * command or restart a service manually.
 */
export class SubscriptionProxyService implements SubscriptionProxyController {
  private startPromise: Promise<SubscriptionProxyStatus> | undefined;
  private installPromise: Promise<string> | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private serviceState: "ready" | "starting" | "error" = "starting";
  private serviceDetail = "Checking the local subscription bridge.";
  private managed = false;
  private readonly loginProcesses = new Map<SubscriptionProxyProvider, ChildProcess>();
  private readonly loginVerifications = new Set<SubscriptionProxyProvider>();
  private readonly loginStates = new Map<SubscriptionProxyProvider, LoginState>();

  constructor(
    private readonly options: {
      storageDir: string;
      resourcesPath?: string;
      packaged?: boolean;
    },
  ) {}

  /** Starts the bridge if needed and returns authoritative model availability. */
  ensureRunning(): Promise<SubscriptionProxyStatus> {
    if (!this.startPromise) {
      this.startPromise = this.startIfNeeded().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  /** Periodically heals a stopped bridge without any user action. */
  startMonitoring(intervalMs = 10_000): void {
    if (this.monitor) {
      return;
    }
    this.monitor = setInterval(() => {
      void this.ensureRunning();
    }, intervalMs);
    this.monitor.unref?.();
  }

  dispose(): void {
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
    for (const child of this.loginProcesses.values()) {
      child.kill();
    }
    this.loginProcesses.clear();
  }

  /** Current state for Authentication/API. Also heals a stopped bridge. */
  async getStatus(): Promise<SubscriptionProxyStatus> {
    return this.ensureRunning();
  }

  /**
   * Opens the provider's browser OAuth flow. The CLI owns refresh-token
   * persistence after this one approval; AgentParty only tracks visible state.
   */
  async login(provider: SubscriptionProxyProvider): Promise<SubscriptionProxyLoginResult> {
    let subscriptions = await this.ensureRunning();
    if (subscriptions[provider].available) {
      return {
        ok: true,
        provider,
        status: "already_available",
        detail: `${providerLabel(provider)} subscription is already connected.`,
        subscriptions,
      };
    }

    if (this.loginProcesses.has(provider) || this.loginVerifications.has(provider)) {
      return {
        ok: true,
        provider,
        status: "pending",
        detail: "Browser authentication is already in progress.",
        subscriptions: this.decorate(subscriptions),
      };
    }

    this.loginStates.set(provider, {
      status: "pending",
      detail: "Preparing the local subscription bridge before opening browser authentication.",
      startedAt: Date.now(),
    });

    let executable: string;
    try {
      executable = await this.ensureExecutable();
    } catch (error) {
      const detail = `Could not prepare the local subscription bridge: ${messageOf(error)}`;
      this.loginStates.set(provider, { status: "error", detail, startedAt: Date.now() });
      subscriptions = this.decorate(subscriptions);
      return { ok: false, provider, status: "error", detail, subscriptions };
    }

    let configPath: string;
    try {
      configPath = await this.ensureConfig();
    } catch (error) {
      const detail = `Could not prepare the subscription bridge configuration: ${messageOf(error)}`;
      this.loginStates.set(provider, { status: "error", detail, startedAt: Date.now() });
      subscriptions = this.decorate(subscriptions);
      return { ok: false, provider, status: "error", detail, subscriptions };
    }

    const child = spawn(executable, ["-config", configPath, `-${provider}-login`], {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.loginProcesses.set(provider, child);
    this.loginStates.set(provider, {
      status: "pending",
      detail: `Complete the ${providerLabel(provider)} approval in the browser. AgentParty will detect it automatically.`,
      startedAt: Date.now(),
    });

    let diagnosticTail = "";
    const capture = (chunk: Buffer) => {
      diagnosticTail = `${diagnosticTail}${chunk.toString("utf8")}`.slice(-6_000);
      // Surface the OAuth URL the moment it is printed. The bridge opens the
      // SYSTEM DEFAULT browser, so a user whose provider account lives in another
      // browser/profile has no way to finish the flow unless we hand them the
      // link. Re-published on every chunk because the URL can span chunks.
      const authUrl = authUrlFromLoginOutput(diagnosticTail);
      const current = this.loginStates.get(provider);
      if (authUrl && current && current.authUrl !== authUrl) {
        this.loginStates.set(provider, { ...current, authUrl });
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let launchFailed = false;
    child.once("error", (error) => {
      launchFailed = true;
      this.loginProcesses.delete(provider);
      const detail = `Could not start ${providerLabel(provider)} authentication: ${messageOf(error)}`;
      this.loginStates.set(provider, { status: "error", detail, startedAt: Date.now() });
      log("error", "subscription-proxy", detail);
    });
    child.once("exit", (code) => {
      this.loginProcesses.delete(provider);
      if (launchFailed) {
        return;
      }
      void this.finishLogin(provider, code, diagnosticTail);
    });

    log("info", "subscription-proxy", "browser OAuth started", { provider });
    subscriptions = this.decorate(subscriptions);
    return {
      ok: true,
      provider,
      status: "started",
      detail: `Complete the ${providerLabel(provider)} approval in the browser.`,
      subscriptions,
    };
  }

  /**
   * CLIProxyAPI's provider login commands can return exit code 0 after OAuth
   * errors. Treat only its explicit credential-save confirmation as progress,
   * then require the provider to appear in the same model endpoint used for
   * routing before clearing Authentication state.
   */
  private async finishLogin(
    provider: SubscriptionProxyProvider,
    code: number | null,
    diagnostic: string,
  ): Promise<void> {
    const safeTail = sanitizeDiagnostic(diagnostic);
    if (code !== 0 || !loginOutputProvesCredentialSaved(diagnostic)) {
      const reason = code === 0
        ? `${providerLabel(provider)} authentication ended without saving credentials`
        : `${providerLabel(provider)} authentication exited with code ${code ?? "unknown"}`;
      const detail = `${reason}${safeTail ? `: ${safeTail}` : "."}`;
      this.loginStates.set(provider, { status: "error", detail, startedAt: Date.now() });
      log("error", "subscription-proxy", detail, { provider });
      return;
    }

    this.loginVerifications.add(provider);
    this.loginStates.set(provider, {
      status: "pending",
      detail: `${providerLabel(provider)} credentials were saved. Waiting for the local bridge to load its models.`,
      startedAt: Date.now(),
    });
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const status = await getSubscriptionProxyStatus();
        if (status[provider].available) {
          this.loginStates.delete(provider);
          log("info", "subscription-proxy", "subscription authentication verified by model discovery", {
            provider,
            modelCount: status[provider].models.length,
          });
          return;
        }
        await delay(500);
      }

      const detail = `${providerLabel(provider)} credentials were saved, but the local bridge did not expose any ${provider} models. ` +
        "The account was not marked connected. No OpenRouter fallback was attempted.";
      this.loginStates.set(provider, { status: "error", detail, startedAt: Date.now() });
      log("error", "subscription-proxy", detail, { provider });
    } finally {
      this.loginVerifications.delete(provider);
    }
  }

  private async startIfNeeded(): Promise<SubscriptionProxyStatus> {
    const current = await getSubscriptionProxyStatus();
    if (current.ok) {
      this.serviceState = "ready";
      this.serviceDetail = "The local subscription bridge is running and will be restarted automatically if needed.";
      return this.decorate(current);
    }

    if (!this.canManageConfiguredUrl()) {
      this.serviceState = "error";
      this.serviceDetail = `The configured subscription proxy is unavailable and is not a local AgentParty-managed URL. ${current.detail || ""}`.trim();
      return this.decorate(current);
    }

    const executable = this.executablePath();
    if (!executable) {
      this.serviceState = "error";
      this.serviceDetail = this.missingExecutableDetail();
      return this.decorate(current);
    }

    try {
      const configPath = await this.ensureConfig();
      this.serviceState = "starting";
      this.serviceDetail = "Starting the local subscription bridge.";
      const child = spawn(executable, ["-config", configPath], {
        cwd: path.dirname(executable),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      this.managed = true;
      log("info", "subscription-proxy", "local subscription bridge started", {
        baseUrl: subscriptionProxyConfig().baseUrl,
        executable,
      });
    } catch (error) {
      this.serviceState = "error";
      this.serviceDetail = `Could not start the local subscription bridge: ${messageOf(error)}`;
      log("error", "subscription-proxy", this.serviceDetail);
      return this.decorate(await getSubscriptionProxyStatus());
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(250);
      const status = await getSubscriptionProxyStatus();
      if (status.ok) {
        this.serviceState = "ready";
        this.serviceDetail = "The local subscription bridge is running and will be restarted automatically if needed.";
        return this.decorate(status);
      }
    }

    this.serviceState = "error";
    this.serviceDetail = `The local subscription bridge did not become ready at ${subscriptionProxyConfig().baseUrl}. Check AgentParty logs for startup failures.`;
    log("error", "subscription-proxy", this.serviceDetail);
    return this.decorate(await getSubscriptionProxyStatus());
  }

  private decorate(status: SubscriptionProxyStatus): SubscriptionProxyStatus {
    for (const provider of ["codex", "claude"] as const) {
      if (status[provider].available) {
        this.loginStates.delete(provider);
      }
      const state = this.loginStates.get(provider);
      if (
        state?.status === "pending" &&
        !this.loginProcesses.has(provider) &&
        !this.loginVerifications.has(provider) &&
        Date.now() - state.startedAt > 180_000
      ) {
        this.loginStates.set(provider, {
          status: "error",
          detail: "Authentication timed out before the account appeared. Start the connection again from Authentication.",
          startedAt: Date.now(),
        });
      }
    }
    return {
      ...status,
      detail: status.ok ? status.detail : this.serviceDetail || status.detail,
      service: {
        status: this.serviceState,
        managed: this.managed,
        detail: this.serviceDetail,
      },
      authentication: Object.fromEntries(this.loginStates) as SubscriptionProxyStatus["authentication"],
    };
  }

  private executablePath(): string | undefined {
    const candidates = [
      process.env.AGENTPARTY_SUBSCRIPTION_PROXY_BIN,
      this.options.packaged && this.options.resourcesPath
        ? path.join(this.options.resourcesPath, "bin", "cli-proxy-api.exe")
        : undefined,
      path.join(this.options.storageDir, "subscription-proxy", "bin", "cli-proxy-api.exe"),
      path.join(os.homedir(), "cliproxyapi", "cli-proxy-api.exe"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  /**
   * Installs the signed-release asset on the first Authentication click when a
   * bridge is not already present. The GitHub-provided SHA-256 digest is
   * mandatory; an unsigned/mismatched asset is never executed.
   */
  private ensureExecutable(): Promise<string> {
    const existing = this.executablePath();
    if (existing) {
      return Promise.resolve(existing);
    }
    if (!this.installPromise) {
      this.installPromise = this.installOfficialRelease().finally(() => {
        this.installPromise = undefined;
      });
    }
    return this.installPromise;
  }

  private async installOfficialRelease(): Promise<string> {
    if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
      throw new Error(`automatic installation is not available for ${process.platform}/${process.arch}`);
    }
    log("info", "subscription-proxy", "downloading official subscription bridge release", {
      platform: process.platform,
      arch: process.arch,
    });
    const releaseResponse = await fetch("https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "AgentParty",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!releaseResponse.ok) {
      throw new Error(`official release lookup failed (${releaseResponse.status})`);
    }
    const release = await releaseResponse.json() as {
      tag_name?: string;
      assets?: Array<{ name?: string; size?: number; digest?: string; browser_download_url?: string }>;
    };
    const platformArch = process.arch === "arm64" ? "windows_arm64" : "windows_amd64";
    const asset = release.assets?.find((candidate) =>
      candidate.name?.toLowerCase().endsWith(`_${platformArch}.zip`),
    );
    if (!asset?.browser_download_url || !asset.name) {
      throw new Error(`official release ${release.tag_name || "latest"} has no ${platformArch} asset`);
    }
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "")?.[1]?.toLowerCase();
    if (!digest) {
      throw new Error("official release asset did not publish a SHA-256 digest");
    }
    if (asset.size && asset.size > 80 * 1024 * 1024) {
      throw new Error(`official release asset is unexpectedly large (${asset.size} bytes)`);
    }

    const assetResponse = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "AgentParty" },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!assetResponse.ok) {
      throw new Error(`official release download failed (${assetResponse.status})`);
    }
    const archive = Buffer.from(await assetResponse.arrayBuffer());
    if (archive.byteLength > 80 * 1024 * 1024) {
      throw new Error(`downloaded release is unexpectedly large (${archive.byteLength} bytes)`);
    }
    const actualDigest = createHash("sha256").update(archive).digest("hex");
    if (actualDigest !== digest) {
      throw new Error("downloaded release failed SHA-256 verification");
    }

    const root = path.resolve(this.options.storageDir, "subscription-proxy");
    const staging = path.join(root, `install-${process.pid}-${Date.now()}`);
    const archivePath = path.join(staging, asset.name);
    const extractDir = path.join(staging, "extracted");
    const destinationDir = path.join(root, "bin");
    const destination = path.join(destinationDir, "cli-proxy-api.exe");
    await fsp.mkdir(extractDir, { recursive: true });
    try {
      await fsp.writeFile(archivePath, archive, { mode: 0o600 });
      await extractZip(archivePath, { dir: extractDir });
      const extracted = await findFile(extractDir, "cli-proxy-api.exe");
      if (!extracted) {
        throw new Error("verified release did not contain cli-proxy-api.exe");
      }
      await fsp.mkdir(destinationDir, { recursive: true });
      await fsp.copyFile(extracted, destination);
      await fsp.writeFile(path.join(root, "version.txt"), `${release.tag_name || "unknown"}\n`, "utf8");
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
    log("info", "subscription-proxy", "official subscription bridge installed", {
      version: release.tag_name,
      destination,
    });
    return destination;
  }

  private async ensureConfig(): Promise<string> {
    const explicit = process.env.AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG;
    if (explicit) {
      if (!fs.existsSync(explicit)) {
        throw new Error(`AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG does not exist: ${explicit}`);
      }
      return explicit;
    }
    const legacy = path.join(os.homedir(), "cliproxyapi", "config.yaml");
    if (fs.existsSync(legacy)) {
      return legacy;
    }

    const config = subscriptionProxyConfig();
    const parsed = new URL(config.baseUrl);
    const configDir = path.join(this.options.storageDir, "subscription-proxy");
    const configPath = path.join(configDir, "config.yaml");
    await fsp.mkdir(configDir, { recursive: true });
    const authDir = path.join(os.homedir(), ".cli-proxy-api").replace(/\\/g, "/");
    const yaml = [
      '# Managed by AgentParty. OAuth credentials persist in the provider auth directory.',
      'host: "127.0.0.1"',
      `port: ${Number(parsed.port) || 8317}`,
      `auth-dir: "${authDir}"`,
      "api-keys:",
      `  - "${config.apiKey.replace(/"/g, "")}"`,
      "debug: false",
      "logging-to-file: false",
      "usage-statistics-enabled: false",
      "",
    ].join("\n");
    await fsp.writeFile(configPath, yaml, { encoding: "utf8", mode: 0o600 });
    return configPath;
  }

  private canManageConfiguredUrl(): boolean {
    const configured = subscriptionProxyConfig().baseUrl;
    if (configured === DEFAULT_SUBSCRIPTION_PROXY_BASE_URL) {
      return true;
    }
    try {
      const host = new URL(configured).hostname.toLowerCase();
      return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
      return false;
    }
  }

  private missingExecutableDetail(): string {
    return "The local subscription bridge is not installed yet. Choose a subscription connection in Authentication and AgentParty will download, verify, install, and start the official bridge automatically. No OpenRouter fallback was attempted.";
  }
}

function providerLabel(provider: SubscriptionProxyProvider): string {
  return provider === "codex" ? "ChatGPT/Codex" : "Claude";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFile(root: string, expectedName: string): Promise<string | undefined> {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase()) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, expectedName);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

/** Prevent OAuth URLs, state parameters, and bearer-like values reaching logs/UI. */
function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/https?:\/\/\S+/gi, "[OAuth URL redacted]")
    .replace(/(access|refresh|id)[_-]?token\s*[:=]\s*\S+/gi, "$1_token=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-500);
}

export function loginOutputProvesCredentialSaved(value: string): boolean {
  return /authentication saved to\s+/i.test(value) && /authentication successful!?/i.test(value);
}

/**
 * The OAuth URL the bridge's login command prints before opening a browser.
 *
 * Matched by PROVIDER AUTHORIZATION SHAPE rather than by the surrounding prose,
 * because that prose differs per provider and across bridge versions. Only real
 * authorization endpoints qualify — a docs or callback link in the same output
 * must never be offered as the thing to click. Returns the LAST match: when a
 * flow reprints its URL, the newest one is the live attempt.
 */
export function authUrlFromLoginOutput(value: string): string | undefined {
  const matches = value.match(/https:\/\/[^\s"'<>]+/g);
  if (!matches) {
    return undefined;
  }
  const authorization = matches.filter((url) => (
    /[?&](client_id|code_challenge|response_type)=/.test(url) && /\/(authorize|oauth|auth)\b/i.test(url)
  ));
  const chosen = authorization[authorization.length - 1];
  return chosen ? chosen.replace(/[.,;)\]]+$/, "") : undefined;
}
