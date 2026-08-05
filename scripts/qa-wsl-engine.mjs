/*
 * WSL-native engine E2E (Stage 3, the WSL remote-engine design).
 *
 * 1. Bundles the engine host and asserts it is Electron-free (bundles for plain
 *    node). 2. Runs it headless under Windows node (sanity). 3. Runs the SAME
 *    bundle natively inside the WSL distro against an ext4 cwd, and verifies the
 *    workspace store landed on ext4 — proving the engine moves to the host where
 *    the workspace lives.
 *
 * Skips the WSL leg (with a clear message, not a failure) where wsl.exe is
 * absent or `--no-wsl` is passed.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const qaDir = qaTempDir();

// --- 1. bundle the engine host (must be Electron-free) --------------------
const bundlePath = path.join(qaDir, "engine-host.mjs");
const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  external: ["electron"], // must not be needed; verified below
});
const code = result.outputFiles[0].text;
writeFileSync(bundlePath, code);
if (/require\(["']electron["']\)|from ["']electron["']/.test(code)) {
  console.error("LEAK: the engine bundle references electron — it is not host-agnostic.");
  process.exit(1);
}
console.log(`✓ engine bundle is Electron-free (${Math.round(code.length / 1024)} KB) → ${bundlePath}`);

const driverPath = path.join(projectRoot, "scripts/engine-e2e-driver.mjs");

// --- 2. Windows headless sanity -------------------------------------------
console.log("\n== Windows headless engine ==");
const winWs = path.join(os.tmpdir(), "agentparty-engine-e2e");
const winStorage = path.join(os.tmpdir(), "agentparty-engine-e2e-storage");
mkdirSync(winWs, { recursive: true });
const winOut = execFileSync(process.execPath, [driverPath, winWs, winStorage, bundlePath], { encoding: "utf8" });
process.stdout.write(winOut);
if (!winOut.includes("ENGINE E2E PASSED")) {
  console.error("Windows headless engine E2E failed.");
  process.exit(1);
}

// --- 3. WSL native run -----------------------------------------------------
if (process.argv.includes("--no-wsl")) {
  console.log("\n(--no-wsl) skipping the WSL leg.");
  process.exit(0);
}
let hasWsl = true;
try { execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore" }); } catch { hasWsl = false; }
if (!hasWsl) {
  console.log("\nWSL not available on this machine — skipping the WSL leg (Windows leg passed).");
  process.exit(0);
}

const distro = process.env.QA_WSL_DISTRO || "";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";
const distroArgs = distro ? ["-d", distro] : [];
const toWsl = (p) => execFileSync("wsl.exe", [...distroArgs, "-e", "wslpath", "-a", p], { encoding: "utf8" }).trim();
const wslBundle = toWsl(bundlePath);
const wslDriver = toWsl(driverPath);

console.log(`\n== WSL native engine ${distro ? `(${distro})` : "(default distro)"} @ ${wslWs} ==`);
const script = [
  "set -e",
  "QA=$HOME/.agentparty-qa",
  "mkdir -p \"$QA/storage\"",
  `cp "${wslBundle}" "$QA/engine-host.mjs"`,
  `cp "${wslDriver}" "$QA/engine-e2e-driver.mjs"`,
  `mkdir -p "${wslWs}"`,
  `node "$QA/engine-e2e-driver.mjs" "${wslWs}" "$QA/storage" "$QA/engine-host.mjs"`,
  "echo '--- workspace fs check ---'",
  `test -f "${wslWs}/.agent_party_app/state.json" && echo STATE_OK`,
  `df -T "${wslWs}/.agent_party_app" | tail -1`,
].join(" && ");
const wslOut = execFileSync("wsl.exe", [...distroArgs, "-e", "bash", "-lc", script], { encoding: "utf8" });
process.stdout.write(wslOut);

const ok = wslOut.includes("ENGINE E2E PASSED") && wslOut.includes("STATE_OK") && /\bext4\b/.test(wslOut);
console.log("");
if (!ok) {
  console.error("WSL ENGINE E2E FAILED");
  process.exit(1);
}
console.log("WSL ENGINE E2E PASSED (engine ran natively in the distro; store on ext4)");
