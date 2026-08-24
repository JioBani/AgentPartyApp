import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { UpdateService } = require(path.join(root, "dist", "main", "updateService.js"));
const { compareVersions, hasActionableUpdate, normalizeUpdateChannel, requireUpdateChannel, updatePillLabel } = require(path.join(root, "dist", "shared", "appUpdate.js"));

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = false;
  allowPrerelease = false;
  channel = null;
  feeds = [];
  checkForUpdates() {
    this.emit("checking-for-update");
    this.emit("update-not-available", { version: this.channel === "beta" ? "0.3.0-beta.10" : "0.2.3" });
    return Promise.resolve({});
  }
  downloadUpdate() { return Promise.resolve({}); }
  quitAndInstall() {}
  setFeedURL(feed) { this.feeds.push(feed); }
}

const updater = new FakeUpdater();
const persisted = [];
const service = new UpdateService({
  getVersion: () => "0.2.3",
  isPackaged: () => true,
  getChannel: () => "stable",
  persistChannel: (channel) => persisted.push(channel),
  updaterFactory: () => updater,
  checkIntervalHours: 0,
});

await service.check();
assert(service.getStatus().channel === "stable", "stable is the initial channel");
assert(updater.channel === "latest" && updater.allowPrerelease === false, "stable config reads latest.yml and rejects prereleases");

const beta = await service.setChannel("beta");
assert(beta.channel === "beta" && beta.state === "up-to-date", "switch performs a settled beta check");
assert(updater.channel === "beta" && updater.allowPrerelease === true, "beta config reads beta.yml and accepts prereleases");
assert(updater.allowDowngrade === true, "channel changes keep rollback/stable migration available");
assert(persisted.join(",") === "beta", "channel is persisted exactly once");

const releases = [
  { version: "0.3.0-beta.1", name: "beta", notes: "", publishedAt: "", url: "", prerelease: true },
  { version: "0.2.3", name: "stable", notes: "", publishedAt: "", url: "", prerelease: false },
];
service.setMockReleases(releases);
assert((await service.listReleases()).length === 2, "beta history includes prerelease and stable releases");
await service.setChannel("stable");
const stableReleases = await service.listReleases();
assert(stableReleases.length === 1 && stableReleases[0].version === "0.2.3", "stable history excludes prereleases");

assert(compareVersions("0.3.0-beta.10", "0.3.0-beta.2") > 0, "numeric prerelease identifiers use SemVer ordering");
assert(compareVersions("0.3.0", "0.3.0-beta.10") > 0, "stable outranks prerelease of the same core");
assert(normalizeUpdateChannel("nightly") === "stable", "invalid legacy settings heal to the safe stable default");
let invalid = "";
try { requireUpdateChannel("nightly"); } catch (error) { invalid = String(error?.message || error); }
assert(invalid.includes("stable") && invalid.includes("beta"), "invalid channel fails with accepted values");

assert(hasActionableUpdate({ state: "available" }) === true, "pill shows when a version is available");
assert(hasActionableUpdate({ state: "downloading" }) === true, "pill shows while downloading");
assert(hasActionableUpdate({ state: "downloaded" }) === true, "pill shows when ready to install");
assert(hasActionableUpdate({ state: "checking" }) === false, "pill hides while checking");
assert(hasActionableUpdate({ state: "up-to-date" }) === false, "pill hides when current");
assert(hasActionableUpdate({ state: "idle" }) === false, "pill hides before the first check");
assert(hasActionableUpdate({ state: "error" }) === false, "pill hides on error");
assert(hasActionableUpdate({ state: "disabled" }) === false, "pill hides when self-update is unavailable");
assert(updatePillLabel({ state: "available", latestVersion: "0.9.0" }) === "업데이트 0.9.0", "available pill names the version");
assert(updatePillLabel({ state: "up-to-date" }) === "", "up-to-date pill is empty");

class CountingUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = false;
  allowPrerelease = false;
  channel = null;
  feeds = [];
  checks = 0;
  pending = undefined;
  outcome = "available";
  checkForUpdates() {
    this.checks += 1;
    this.emit("checking-for-update");
    return new Promise((resolve) => {
      this.pending = () => {
        if (this.outcome === "available") {
          this.emit("update-available", { version: "0.9.0" });
        } else {
          this.emit("update-not-available", { version: "0.2.3" });
        }
        resolve({});
      };
    });
  }
  downloadUpdate() {
    this.emit("download-progress", { percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 });
    return new Promise(() => {});
  }
  quitAndInstall() {}
  setFeedURL(feed) { this.feeds.push(feed); }
}

function makeService(factory) {
  return new UpdateService({
    getVersion: () => "0.2.3",
    isPackaged: () => true,
    getChannel: () => "stable",
    updaterFactory: factory,
    checkIntervalHours: 0,
  });
}

const delayed = new CountingUpdater();
const quietService = makeService(() => delayed);
assert(quietService.getStatus().state === "idle", "fresh service starts idle");
const quietProbe = quietService.check({ quiet: true });
assert(quietService.getStatus().state === "idle", "quiet check does not paint checking");
delayed.pending();
await quietProbe;
assert(quietService.getStatus().state === "available" && quietService.getStatus().latestVersion === "0.9.0", "quiet check settles available");
assert(delayed.checks === 1, "first quiet check hits the feed");
const reused = await quietService.check({ quiet: true });
assert(delayed.checks === 1, "quiet check within 60s reuses the settled result");
assert(reused.state === "available", "debounced quiet check returns the current status");
const loudProbe = quietService.check();
assert(quietService.getStatus().state === "checking", "manual check still paints checking");
assert(delayed.checks === 2, "manual check is not debounced");
delayed.pending();
await loudProbe;
assert(quietService.getStatus().state === "available", "manual check settles available");

const downloadUpdater = new CountingUpdater();
const downloadService = makeService(() => downloadUpdater);
const firstDownloadCheck = downloadService.check();
downloadUpdater.pending();
await firstDownloadCheck;
void downloadService.download();
await new Promise((resolve) => setTimeout(resolve, 0));
assert(downloadService.getStatus().state === "downloading", "download started");
const checksBefore = downloadUpdater.checks;
await downloadService.check();
await downloadService.check({ quiet: true });
assert(downloadUpdater.checks === checksBefore, "check during download does not hit the feed");
assert(downloadService.getStatus().state === "downloading", "download status is preserved across a skipped check");

if (failures.length) {
  throw new Error(`UPDATE CHANNEL QA FAILED: ${failures.join("; ")}`);
}
console.log("UPDATE CHANNEL QA PASSED");
