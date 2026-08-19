import { EventEmitter } from "node:events";
import { log } from "./logger";
import {
  UPDATE_FEED,
  compareVersions,
  initialUpdateStatus,
  normalizeUpdateChannel,
  releaseNotesToMarkdown,
  releaseTagUrl,
  versionFromTag,
  type ReleaseSummary,
  type UpdateChannel,
  type UpdateStatus,
} from "../shared/appUpdate";

/**
 * App self-update against the public GitHub releases repo.
 *
 * Owns ONE piece of state — the current `UpdateStatus` — and emits `"status"`
 * whenever it changes, so main can fan it out to every window. Nothing here
 * touches the UI, and the renderer never talks to GitHub itself.
 *
 * Deliberate choices:
 *  - `autoDownload = false`. The user asked to be *told*, then decides. A
 *    background download on a metered connection is not ours to start.
 *  - Failures are surfaced as `state: "error"` with the real reason. There is no
 *    quiet retry that leaves the UI reading "up to date" after a failed check.
 *  - A run that cannot self-update (dev, portable build) reports `"disabled"`
 *    with the reason instead of erroring on every check.
 *
 * `electron-updater` is imported lazily so this module stays loadable from the
 * QA scripts that run outside an Electron process.
 */

/** The slice of `electron-updater`'s autoUpdater we use — kept explicit so the lazy import stays typed. */
interface AutoUpdaterLike extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  channel: string | null;
  setFeedURL(options: unknown): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceDeps {
  /** Version of the running build. */
  getVersion: () => string;
  /** False for `npm start` / `vite` dev runs — self-update is impossible there. */
  isPackaged: () => boolean;
  /** Persisted machine-global release stream. */
  getChannel?: () => UpdateChannel;
  /** Called before a channel switch becomes active. A write failure is surfaced. */
  persistChannel?: (channel: UpdateChannel) => void;
  /** Test seam: production lazily requires electron-updater instead. */
  updaterFactory?: () => AutoUpdaterLike;
  /** How often to re-check while the app stays open. 0 disables the timer. */
  checkIntervalHours?: number;
}

const DEFAULT_CHECK_INTERVAL_HOURS = 6;
/** How long a fetched release list stays good. GitHub allows 60 anonymous req/hour. */
const RELEASE_CACHE_MS = 10 * 60 * 1000;

/**
 * Turns an updater error into one sentence a user can act on, keeping the raw
 * text in the log. The common failures are named because "404" alone tells
 * nobody that the release repo is missing or has no published release yet.
 */
export function describeUpdateError(detail: string): string {
  const feed = `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`;
  // The repo is reachable but empty — the state right after creating the
  // releases repo, before the first `npm run release:win`.
  if (/No published versions/i.test(detail)) {
    return `아직 게시된 릴리스가 없습니다 (${feed}).`;
  }
  if (/\b404\b/.test(detail)) {
    return `릴리스를 찾을 수 없습니다 (${feed}). 저장소가 공개되어 있고 게시된 릴리스가 있는지 확인하세요.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network/i.test(detail)) {
    return "업데이트 서버에 연결하지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요.";
  }
  if (/sha512|checksum/i.test(detail)) {
    return "내려받은 파일이 손상되었습니다(체크섬 불일치). 다시 다운로드하세요.";
  }
  // Unknown failure: the first line, capped — enough to recognize, and the full
  // text is in the log folder.
  const firstLine = detail.split("\n").map((line) => line.trim()).find(Boolean) || "알 수 없는 오류";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

export class UpdateService extends EventEmitter {
  private status: UpdateStatus;
  private channel: UpdateChannel;
  private updater: AutoUpdaterLike | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<UpdateStatus> | undefined;
  /** Set by QA to drive the UI without a real release. */
  private mocked = false;
  private releaseCache: { at: number; releases: ReleaseSummary[] } | undefined;
  /** Set by QA to render the 버전 tab without publishing throwaway releases. */
  private mockedReleases: ReleaseSummary[] | undefined;

  constructor(private readonly deps: UpdateServiceDeps) {
    super();
    this.channel = normalizeUpdateChannel(deps.getChannel?.());
    this.status = initialUpdateStatus(deps.getVersion(), this.channel);
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  getChannel(): UpdateChannel {
    return this.channel;
  }

  /**
   * Changes the release stream, persists it, reconfigures the existing updater,
   * and performs one settled check so UI and API callers see the same outcome.
   */
  async setChannel(channel: UpdateChannel): Promise<UpdateStatus> {
    if (channel === this.channel) {
      return this.getStatus();
    }
    if (this.inFlight || this.status.state === "downloading") {
      throw new Error("업데이트 확인 또는 다운로드가 진행 중일 때는 채널을 바꿀 수 없습니다.");
    }
    this.stop();
    this.deps.persistChannel?.(channel);
    this.channel = channel;
    this.mocked = false;
    this.status = initialUpdateStatus(this.deps.getVersion(), channel);
    if (this.updater) {
      this.configureUpdater(this.updater);
    }
    this.emit("status", this.getStatus());
    const result = await this.check();
    this.armTimer();
    return result;
  }

  /**
   * Wires the updater and runs the first check. Safe to call once, after the
   * first window exists; a check before that would have nowhere to report to.
   */
  start(): void {
    // Idempotent: a restart (after a QA mock is dropped) must not leave two timers.
    this.stop();
    const blocked = this.blockedReason();
    if (blocked) {
      this.patch({ state: "disabled", disabledReason: blocked });
      log("info", "update", "self-update unavailable", { reason: blocked });
      return;
    }
    void this.check();
    this.armTimer();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Asks the feed what the latest release is. Never throws — failures land in the status. */
  async check(): Promise<UpdateStatus> {
    if (this.mocked) {
      return this.getStatus();
    }
    const blocked = this.blockedReason();
    if (blocked) {
      this.patch({ state: "disabled", disabledReason: blocked });
      return this.getStatus();
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const updater = this.ensureUpdater();
        this.patch({ state: "checking", error: undefined });
        await updater.checkForUpdates();
      } catch (error) {
        // The `error` event usually fires too, but a throw before the updater is
        // wired (bad feed config, no app-update.yml) would otherwise be silent.
        this.fail(error);
      } finally {
        this.inFlight = undefined;
      }
      return this.getStatus();
    })();
    return this.inFlight;
  }

  /** Downloads the pending installer. Progress arrives as `"status"` events. */
  async download(): Promise<UpdateStatus> {
    if (this.mocked) {
      return this.getStatus();
    }
    if (this.status.state !== "available" && this.status.state !== "error") {
      // Nothing to download — say so rather than starting a no-op that looks busy.
      throw new Error(`다운로드할 업데이트가 없습니다 (현재 상태: ${this.status.state}).`);
    }
    const updater = this.ensureUpdater();
    this.patch({ state: "downloading", error: undefined, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.getStatus();
  }

  /**
   * Quits and runs the downloaded installer. Returns only if it could NOT be
   * started — on success the process is already going away.
   */
  install(): { ok: true } {
    if (this.status.state !== "downloaded") {
      throw new Error("설치할 업데이트가 아직 다운로드되지 않았습니다.");
    }
    log("info", "update", "quit and install", { version: this.status.latestVersion });
    // isSilent=false → show the NSIS progress; isForceRunAfter=true → relaunch.
    this.ensureUpdater().quitAndInstall(false, true);
    return { ok: true };
  }

  /**
   * QA hook: pins a status so the UI can be driven without a real release.
   * Mirrors `setMockEnvironmentReport` — once set, real checks are skipped so a
   * background timer cannot overwrite what the test is looking at.
   */
  setMockStatus(patch: Partial<UpdateStatus> | undefined): UpdateStatus {
    if (!patch) {
      this.mocked = false;
      this.mockedReleases = undefined;
      this.status = initialUpdateStatus(this.deps.getVersion(), this.channel);
      this.emit("status", this.getStatus());
      // Back to the real thing — including the periodic check the mock stopped,
      // and the honest "this build cannot self-update" when that is the case.
      this.start();
      return this.getStatus();
    }
    this.mocked = true;
    this.stop();
    this.patch(patch);
    return this.getStatus();
  }

  /**
   * QA hook: stands a fixed release history in for the GitHub fetch, so the
   * 버전 tab can be reviewed without publishing throwaway releases to a public
   * repo. Cleared by the same `{"reset":true}` that drops the status mock.
   */
  setMockReleases(releases: ReleaseSummary[] | undefined): ReleaseSummary[] | undefined {
    this.mockedReleases = releases && releases.length ? releases : undefined;
    return this.mockedReleases;
  }

  /**
   * Every published release, newest first — what the 설정 → 버전 tab lists.
   *
   * Read straight from the public REST API with no token: the releases repo is
   * public precisely so this works anonymously. Cached for 10 minutes because
   * unauthenticated GitHub allows 60 requests/hour per IP and this list changes
   * only when we publish.
   *
   * Independent of the updater's own state — the tab must be able to show the
   * history even on a build where self-update is disabled (a dev run).
   */
  async listReleases(refresh = false): Promise<ReleaseSummary[]> {
    if (this.mockedReleases) {
      return this.releasesForChannel(this.mockedReleases);
    }
    const fresh = this.releaseCache && Date.now() - this.releaseCache.at < RELEASE_CACHE_MS;
    if (fresh && !refresh) {
      return this.releasesForChannel(this.releaseCache!.releases);
    }
    const url = `https://api.github.com/repos/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases?per_page=50`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "AgentParty" } });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("error", "update", "release list fetch failed", { detail });
      throw new Error(`릴리스 목록을 가져오지 못했습니다: ${describeUpdateError(detail)}`);
    }
    if (!response.ok) {
      // 403 here is almost always the hourly rate limit, which is worth naming:
      // "실패"에 그치면 사용자가 네트워크를 의심하며 계속 재시도한다.
      const hint = response.status === 403 || response.status === 429
        ? " GitHub 요청 한도에 걸렸을 수 있습니다. 잠시 후 다시 시도하세요."
        : "";
      log("error", "update", "release list http error", { status: response.status });
      throw new Error(`릴리스 목록을 가져오지 못했습니다 (HTTP ${response.status}).${hint}`);
    }
    const raw = await response.json() as Array<{
      tag_name?: string; name?: string; body?: string; published_at?: string;
      html_url?: string; prerelease?: boolean; draft?: boolean;
    }>;
    const current = this.deps.getVersion();
    const releases: ReleaseSummary[] = (Array.isArray(raw) ? raw : [])
      // Drafts never reach an anonymous caller, but a token-bearing one would
      // see them — they are not released, so they are not history.
      .filter((entry) => !entry.draft && entry.tag_name)
      .map((entry) => {
        const version = versionFromTag(String(entry.tag_name));
        return {
          version,
          name: String(entry.name || entry.tag_name),
          notes: String(entry.body || "").trim(),
          publishedAt: String(entry.published_at || ""),
          url: String(entry.html_url || releaseTagUrl(version)),
          prerelease: Boolean(entry.prerelease),
          current: version === current,
        };
      });
    this.releaseCache = { at: Date.now(), releases };
    log("info", "update", "release list loaded", { count: releases.length });
    return this.releasesForChannel(releases);
  }

  /** Non-empty when this build cannot self-update, explaining why. */
  private blockedReason(): string {
    if (!this.deps.isPackaged()) {
      return "개발 실행(패키징되지 않은 빌드)에서는 자동 업데이트가 동작하지 않습니다.";
    }
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      return "포터블 빌드는 자동 업데이트를 지원하지 않습니다. 설치본(Setup.exe)을 사용하세요.";
    }
    return "";
  }

  private ensureUpdater(): AutoUpdaterLike {
    if (this.updater) {
      return this.updater;
    }
    // Lazy + `require`: pulling electron-updater at module load would break the
    // QA scripts that import this file outside Electron.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const autoUpdater = this.deps.updaterFactory
      ? this.deps.updaterFactory()
      : (require("electron-updater") as { autoUpdater: AutoUpdaterLike }).autoUpdater;
    this.configureUpdater(autoUpdater);
    this.wireUpdater(autoUpdater);
    this.updater = autoUpdater;
    return autoUpdater;
  }

  /** Applies a channel without recreating the singleton autoUpdater. */
  private configureUpdater(autoUpdater: AutoUpdaterLike): void {
    autoUpdater.autoDownload = false;
    // Installing quits the app, which kills every running member — so it happens
    // only when the user asks. Left on (the electron-updater default), a
    // downloaded update would install on the next ordinary app close, which for
    // this app is never an incidental moment.
    autoUpdater.autoInstallOnAppQuit = false;
    // Lets a BAD release be recalled: unpublish it and `latest.yml` points back
    // at the good version, which every installed app then moves to. Without
    // this, an app that already took the bad build stays on it forever.
    autoUpdater.allowPrerelease = this.channel === "beta";
    autoUpdater.channel = this.channel === "beta" ? "beta" : "latest";
    autoUpdater.allowDowngrade = true;
    // Set explicitly rather than relying on the generated app-update.yml, so the
    // feed has exactly one source of truth (shared/appUpdate.ts).
    autoUpdater.setFeedURL({ ...UPDATE_FEED });
  }

  private wireUpdater(autoUpdater: AutoUpdaterLike): void {
    autoUpdater.on("checking-for-update", () => this.patch({ state: "checking" }));
    autoUpdater.on("update-available", (info: { version?: string; releaseNotes?: unknown; releaseDate?: string }) => {
      const version = String(info?.version || "");
      // With allowDowngrade on, "available" can mean the feed rolled BACK.
      const downgrade = Boolean(version) && compareVersions(version, this.deps.getVersion()) < 0;
      this.patch({
        state: "available",
        downgrade,
        latestVersion: version,
        // GitHub sends rendered HTML here; the dialog renders markdown.
        releaseNotes: typeof info?.releaseNotes === "string" ? releaseNotesToMarkdown(info.releaseNotes) : undefined,
        releaseDate: info?.releaseDate,
        releaseUrl: version ? releaseTagUrl(version) : undefined,
        checkedAt: new Date().toISOString(),
        error: undefined,
      });
      log("info", "update", "update available", { version });
    });
    autoUpdater.on("update-not-available", (info: { version?: string }) => {
      this.patch({
        state: "up-to-date",
        downgrade: false,
        latestVersion: info?.version ? String(info.version) : this.deps.getVersion(),
        checkedAt: new Date().toISOString(),
        error: undefined,
      });
    });
    autoUpdater.on("download-progress", (progress: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number }) => {
      this.patch({
        state: "downloading",
        progress: {
          percent: Number(progress?.percent || 0),
          transferred: Number(progress?.transferred || 0),
          total: Number(progress?.total || 0),
          bytesPerSecond: Number(progress?.bytesPerSecond || 0),
        },
      });
    });
    autoUpdater.on("update-downloaded", (info: { version?: string }) => {
      this.patch({ state: "downloaded", latestVersion: info?.version ? String(info.version) : this.status.latestVersion, progress: undefined });
      log("info", "update", "update downloaded", { version: this.status.latestVersion });
    });
    autoUpdater.on("error", (error: unknown) => this.fail(error));
  }

  private releasesForChannel(releases: ReleaseSummary[]): ReleaseSummary[] {
    return this.channel === "beta" ? [...releases] : releases.filter((release) => !release.prerelease);
  }

  private armTimer(): void {
    if (this.blockedReason()) {
      return;
    }
    const hours = this.deps.checkIntervalHours ?? DEFAULT_CHECK_INTERVAL_HOURS;
    if (hours > 0) {
      this.timer = setInterval(() => { void this.check(); }, hours * 60 * 60 * 1000);
      this.timer.unref?.();
    }
  }

  private fail(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    // The log keeps everything; the UI gets a sentence. electron-updater's
    // errors carry the full HTTP response — headers and Set-Cookie included —
    // which is unreadable in a dialog and not something to paint on screen.
    log("error", "update", "update check failed", { detail });
    this.patch({ state: "error", error: describeUpdateError(detail), checkedAt: new Date().toISOString(), progress: undefined });
  }

  private patch(patch: Partial<UpdateStatus>): void {
    const next: UpdateStatus = { ...this.status, ...patch, channel: this.channel, currentVersion: this.deps.getVersion() };
    // A reason belongs to the state that produced it. Carrying `error` or
    // `disabledReason` into a later state would leave the UI explaining a
    // failure that is no longer true.
    if (next.state !== "error") {
      delete next.error;
    }
    if (next.state !== "disabled") {
      delete next.disabledReason;
    }
    this.status = next;
    this.emit("status", this.getStatus());
  }
}
