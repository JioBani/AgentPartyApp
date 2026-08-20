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

const wsl2204 = "wsl+Ubuntu-22.04:/tmp/ws";
assert(
  local.localFileHostPath("/mnt/c/a", wsl2204, "win32") === "C:\\a",
  "WSL window /mnt/c/a becomes the Windows drive, not \\\\wsl$\\distro\\mnt\\c",
);
assert(
  local.localFileHostPath("/mnt/C/Users/Public/x", wsl2204, "win32") === "C:\\Users\\Public\\x",
  "WSL window /mnt/<drive>/Users/... becomes C:\\Users\\...",
);
assert(
  local.localFileHostPath("/mnt/c", wsl2204, "win32") === "C:\\",
  "WSL window /mnt/c with no rest is C:\\",
);
assert(
  local.localFileHostPath("/mnt/wsl/data", wsl2204, "win32") === "\\\\wsl$\\Ubuntu-22.04\\mnt\\wsl\\data",
  "/mnt/wsl is not a drive letter and stays a distro path",
);
assert(
  local.localFileHostPath("/mnt/abc/x", wsl2204, "win32") === "\\\\wsl$\\Ubuntu-22.04\\mnt\\abc\\x",
  "/mnt/abc is not a single-letter drive",
);
assert(
  local.localFileHostPath("/home/a", wsl2204, "win32") === "\\\\wsl$\\Ubuntu-22.04\\home\\a",
  "distro-native /home stays on the distro UNC",
);
assert(
  local.localFileHostPath("/tmp/a", wsl2204, "win32") === "\\\\wsl$\\Ubuntu-22.04\\tmp\\a",
  "distro-native /tmp stays on the distro UNC",
);
assert(
  local.localFileHostPath("docs/a", wsl2204, "win32") === "\\\\wsl$\\Ubuntu-22.04\\tmp\\ws\\docs\\a",
  "relative link in a WSL window resolves against the distro workspace",
);
assert(
  local.localFileHostPath("C:\\x", wsl2204, "win32") === "C:\\x",
  "C:\\ stays Windows in a WSL window",
);
assert(
  local.localFileHostPath("/C:/x", wsl2204, "win32") === "/C:/x",
  "/C:/ is classified as a Windows drive before WSL translation (caller normalizes)",
);
assert(
  local.localFileHostPath("wsl+Debian:/home/a", wsl2204, "win32") === "\\\\wsl$\\Debian\\home\\a",
  "explicit target distro wins over the window distro",
);
assert(
  local.localFileHostPath("\\\\wsl.localhost\\Debian\\home\\a", wsl2204, "win32") === "\\\\wsl$\\Debian\\home\\a",
  "explicit \\\\wsl.localhost\\<distro> wins over the window distro",
);
assert(
  local.localFileHostPath("\\\\wsl$\\Ubuntu-22.04\\mnt\\c\\Users\\Public\\x", wsl2204, "win32") === "C:\\Users\\Public\\x",
  "explicit WSL UNC of /mnt/<drive> becomes the Windows drive",
);
assert(
  local.localFileHostPath("wsl+Debian:/mnt/c/a", localWindow, "win32") === "C:\\a",
  "explicit WSL /mnt/<drive> becomes the Windows drive even from a local window",
);
assert(
  local.localFileHostPath("/home/a", localWindow, "win32") === "/home/a",
  "a local window does not guess a distro for anonymous /home",
);
assert(
  local.localFileHostPath("/mnt/c/a", wsl2204, "linux") === "/mnt/c/a",
  "inside the distro /mnt/c is already native — no C:\\ rewrite",
);
assert(
  local.localFileHostPath("/home/나 공백.md", wsl2204, "win32") === "\\\\wsl$\\Ubuntu-22.04\\home\\나 공백.md",
  "Hangul and spaces in a distro path are preserved",
);

const hosted = (raw, workspace = wsl2204, platform = "win32") => {
  const decoded = local.decodeLocalFileTarget(raw);
  const normalized = local.normalizeLocalFileTarget(decoded, platform);
  return local.localFileHostPath(normalized, workspace, platform);
};
assert(hosted("file:///mnt/c/a") === "C:\\a", "file:///mnt/c/a in a WSL window is C:\\a");
assert(hosted("file:///home/a") === "\\\\wsl$\\Ubuntu-22.04\\home\\a", "file:///home/a in a WSL window is the distro UNC");
assert(hosted("file:///C:/a") === "C:/a", "file:///C:/a stays a Windows drive");
assert(
  hosted("file://wsl.localhost/Debian/home/a") === "\\\\wsl$\\Debian\\home\\a",
  "file://wsl.localhost/<distro>/... uses the named distro",
);
assert(
  hosted("file://wsl.localhost/Debian/mnt/c/a") === "C:\\a",
  "file://wsl.localhost/Debian/mnt/c/a is C:\\a even in explicit-distro context",
);
assert(hosted("file:///mnt/c/a", localWindow) === "/mnt/c/a", "file:///mnt/c in a local window does not guess a distro");
assert(hosted("file:///home/a", localWindow) === "/home/a", "file:///home in a local window does not guess a distro");
assert(
  local.decodeLocalFileTarget("file:///home/me/a.md#section") === "/home/me/a.md",
  "file URL # is a fragment, not a filename",
);
assert(
  local.decodeLocalFileTarget("file:///home/me/foo%23bar.md") === "/home/me/foo#bar.md",
  "literal # in a file name is only %23",
);
assert(
  local.decodeLocalFileTarget("file:///home/me/%EC%84%A4%EA%B3%84%20a.md") === "/home/me/설계 a.md",
  "percent-decoding of Hangul and spaces happens once",
);
assert(
  local.decodeLocalFileTarget("/home/me/%20plus+plus") === "/home/me/ plus+plus",
  "non-URL percent decode is once; + stays +",
);
let malformed = "";
try {
  local.parseLocalFileUrl("file:///%ZZ");
} catch (error) {
  malformed = String(error?.message || error);
}
assert(/Not a readable file URL/.test(malformed), `malformed file URL is a readable error (${malformed})`);
let badHost = "";
try {
  local.parseLocalFileUrl("file://example.com/etc/passwd");
} catch (error) {
  badHost = String(error?.message || error);
}
assert(/Not a readable file URL/.test(badHost), "a non-local file: host is rejected");
assert(local.isLaunchable("C:\\a.md") === true, "a document stays launchable after drive rewrite");
assert(local.isLaunchable("\\\\wsl$\\Ubuntu-22.04\\tmp\\a.sh") === false, "isLaunchable uses the resolved path's extension");

if (failures.length) {
  console.error(`\nLOCAL FILE PATH QA FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nLOCAL FILE PATH QA PASSED");
