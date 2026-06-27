/*
 * WorkspaceLocation codec unit test (Stage 1 of the WSL remote effort, see
 * docs/WSL_REMOTE.md). Pure functions, so verify directly. The key guarantee:
 * local locations are byte-identical to the previous `path.resolve(path)` logic,
 * so adopting the codec changes nothing for local workspaces.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/shared/workspaceLocation.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "workspaceLocation.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const W = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("WorkspaceLocation codec assertions:");

// --- local: backward compatible, byte-identical identity ------------------
const winPath = "C:\\Project\\AgentPartyApp";
const local = W.parseWorkspaceLocation(winPath);
assert(local.host.kind === "local", "a Windows path parses as local");
assert(local.path === winPath, "local keeps the raw path");
assert(W.serializeWorkspaceLocation(local) === winPath, "local serializes back to the raw path (no URI)");
assert(W.workspaceKey(winPath) === path.resolve(winPath), "local key equals the platform path.resolve (identical to old logic)");

// a relative-ish local path still resolves like before
assert(W.workspaceKey("C:\\a\\b\\..\\c") === path.resolve("C:\\a\\b\\..\\c"), "local key normalizes via the platform path.resolve");

// --- wsl: URI round-trips and gets a stable, non-Windows identity ---------
const uri = "wsl+Ubuntu:/home/user/project";
const wsl = W.parseWorkspaceLocation(uri);
assert(wsl.host.kind === "wsl" && wsl.host.distro === "Ubuntu", "wsl URI parses distro");
assert(wsl.path === "/home/user/project", "wsl URI parses the posix path");
assert(W.serializeWorkspaceLocation(wsl) === uri, "wsl serializes back to the same URI");
assert(W.workspaceKey(uri) === "wsl+Ubuntu:/home/user/project", "wsl key is the normalized URI, not a Windows path");
assert(!W.workspaceKey(uri).includes("C:\\"), "wsl key is never mangled into a Windows path");

// distro with a dash; posix normalization in the key
const uri2 = "wsl+Ubuntu-22.04:/home/user/./a/../proj";
assert(W.workspaceKey(uri2) === "wsl+Ubuntu-22.04:/home/user/proj", "wsl key posix-normalizes the path");

// --- UNC: a \\wsl$\ / \\wsl.localhost\ folder pick becomes a WSL location ---
const unc1 = W.parseWorkspaceLocation("\\\\wsl$\\Ubuntu-22.04\\home\\dev\\project");
assert(unc1.host.kind === "wsl" && unc1.host.distro === "Ubuntu-22.04", "\\\\wsl$ UNC parses distro");
assert(unc1.path === "/home/dev/project", "\\\\wsl$ UNC parses the posix path");
assert(W.serializeWorkspaceLocation(unc1) === "wsl+Ubuntu-22.04:/home/dev/project", "\\\\wsl$ UNC serializes to the wsl URI");
const unc2 = W.parseWorkspaceLocation("\\\\wsl.localhost\\Debian\\srv\\app");
assert(unc2.host.kind === "wsl" && unc2.host.distro === "Debian" && unc2.path === "/srv/app", "\\\\wsl.localhost UNC parses to wsl location");

// --- isolation: local and wsl with the same tail are different identities -
assert(W.workspaceKey("/home/user/project") !== W.workspaceKey("wsl+Ubuntu:/home/user/project"), "local vs wsl with same path are distinct identities");
assert(W.workspaceKey("wsl+Ubuntu:/p") !== W.workspaceKey("wsl+Debian:/p"), "same path on different distros are distinct identities");

// --- equality helper ------------------------------------------------------
assert(W.workspaceLocationsEqual(W.parseWorkspaceLocation(uri), W.parseWorkspaceLocation(uri)), "equal locations compare equal");
assert(!W.workspaceLocationsEqual(W.parseWorkspaceLocation(uri), local), "different hosts compare unequal");

console.log("");
if (failures.length) {
  console.log(`WORKSPACE LOCATION FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("WORKSPACE LOCATION PASSED");
process.exit(0);
