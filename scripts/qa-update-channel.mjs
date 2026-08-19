import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { UpdateService } = require(path.join(root, "dist", "main", "updateService.js"));
const { compareVersions, normalizeUpdateChannel, requireUpdateChannel } = require(path.join(root, "dist", "shared", "appUpdate.js"));

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

if (failures.length) {
  throw new Error(`UPDATE CHANNEL QA FAILED: ${failures.join("; ")}`);
}
console.log("UPDATE CHANNEL QA PASSED");
