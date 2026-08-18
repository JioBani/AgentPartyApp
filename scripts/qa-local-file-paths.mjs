/* Pure regression coverage for model-authored local file paths. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(root, "src/shared/localFiles.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const bundlePath = path.join(qaTempDir(), "localFiles.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const local = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

assert(local.normalizeLocalFileTarget("/C:/Project/발표.html", "win32") === "C:/Project/발표.html", "URL-shaped Windows drive path loses its synthetic leading slash");
assert(local.normalizeLocalFileTarget("\\C:\\Project\\발표.html", "win32") === "C:\\Project\\발표.html", "backslash-prefixed Windows drive path is restored");
assert(local.normalizeLocalFileTarget("C:\\Project\\발표.html", "win32") === "C:\\Project\\발표.html", "normal Windows drive path is unchanged");
assert(local.normalizeLocalFileTarget("/home/dev/발표.html", "linux") === "/home/dev/발표.html", "POSIX/WSL absolute path is unchanged");
assert(local.normalizeLocalFileTarget("/C:/literal-posix-name", "linux") === "/C:/literal-posix-name", "drive-like POSIX filename is unchanged off Windows");
assert(local.normalizeLocalFileTarget("\\\\server\\share\\발표.html", "win32") === "\\\\server\\share\\발표.html", "UNC path is unchanged");
assert(local.isWindowsDrivePath("C:/Project/a.html") && local.isWindowsDrivePath("/C:/Project/a.html"), "plain and URL-shaped drive paths are classified as files");

// --- which host owns a link's target (the WSL bug: `/home/…` read as `C:\home\…`) ---
const wslWindow = "wsl+Ubuntu-20.04:/home/me/proj";
const localWindow = "C:\\Project\\app";
assert(
  local.localFileHostPath("/home/me/proj/설계.md", wslWindow, "win32") === "\\\\wsl$\\Ubuntu-20.04\\home\\me\\proj\\설계.md",
  "POSIX link in a WSL window resolves to the distro's UNC view",
);
assert(
  local.localFileHostPath("docs/설계.md", wslWindow, "win32") === "\\\\wsl$\\Ubuntu-20.04\\home\\me\\proj\\docs\\설계.md",
  "relative link in a WSL window resolves against the WSL workspace",
);
assert(
  local.localFileHostPath("../other/a.md", wslWindow, "win32") === "\\\\wsl$\\Ubuntu-20.04\\home\\me\\other\\a.md",
  "`..` in a WSL relative link is applied in POSIX space",
);
assert(
  local.localFileHostPath("C:\\Project\\a.md", wslWindow, "win32") === "C:\\Project\\a.md",
  "a Windows drive path stays Windows even in a WSL window",
);
assert(
  local.localFileHostPath("/home/me/proj/설계.md", wslWindow, "linux") === "/home/me/proj/설계.md",
  "inside the distro the POSIX path is already native — no UNC",
);
assert(
  local.localFileHostPath("wsl+Ubuntu-20.04:/home/me/a.md", localWindow, "win32") === "\\\\wsl$\\Ubuntu-20.04\\home\\me\\a.md",
  "a link naming its own distro wins over the window's workspace",
);
assert(
  local.localFileHostPath("\\\\wsl$\\Ubuntu-20.04\\home\\me\\a.md", localWindow, "win32") === "\\\\wsl$\\Ubuntu-20.04\\home\\me\\a.md",
  "an already-UNC WSL path survives the round trip unchanged",
);
assert(
  local.localFileHostPath("/home/me/a.md", localWindow, "win32") === "/home/me/a.md",
  "a local window leaves the path alone — the caller's own resolution applies",
);
assert(
  local.localFileHostPath("docs/a.md", localWindow, "win32") === "docs/a.md",
  "a local window's relative link is left for the caller to resolve",
);

if (failures.length) {
  console.error(`\nLOCAL FILE PATH QA FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nLOCAL FILE PATH QA PASSED");
