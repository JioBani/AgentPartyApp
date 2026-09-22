import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { EnvironmentBlockedError } from "./environmentError";
import { resolveOnPath } from "./commandProbe";

const execFileAsync = promisify(execFile);

export interface MuseCliInfo {
  command: string;
  version: string;
  release: string;
}

function windowsNativeBinary(directory: string): string | undefined {
  const versionFile = path.join(directory, ".muse-version");
  if (fs.existsSync(versionFile)) {
    const release = fs.readFileSync(versionFile, "utf8").trim();
    const versioned = path.join(directory, `muse-bin-${release}.exe`);
    if (release && fs.existsSync(versioned)) return versioned;
  }
  const binaries = fs.existsSync(directory)
    ? fs.readdirSync(directory)
      .filter((name) => /^muse-bin-.+\.exe$/i.test(name))
      .map((name) => path.join(directory, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  return binaries[0];
}

function normalizeCandidate(candidate: string): string | undefined {
  if (process.platform !== "win32") return candidate;
  if (/\.exe$/i.test(candidate) && fs.existsSync(candidate)) return candidate;
  const resolved = fs.existsSync(candidate) ? candidate : resolveOnPath(candidate);
  if (!resolved) return undefined;
  if (/\.exe$/i.test(resolved)) return resolved;
  if (/\.(?:cmd|bat|ps1)$/i.test(resolved)) return windowsNativeBinary(path.dirname(resolved));
  return resolved;
}

function candidatePaths(explicit?: string): string[] {
  const configured = String(explicit || "").trim();
  if (configured) return [configured];
  const fromEnv = String(process.env.AGENTPARTY_MUSE_BIN || "").trim();
  if (fromEnv) return [fromEnv];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return [
      local ? windowsNativeBinary(path.join(local, "Programs", "muse")) : undefined,
      "muse",
    ].filter((value): value is string => Boolean(value));
  }
  return [path.join(os.homedir(), ".local", "bin", "muse"), "muse"];
}

export async function resolveMuseCli(explicit?: string): Promise<MuseCliInfo> {
  const failures: string[] = [];
  for (const candidate of candidatePaths(explicit)) {
    const command = normalizeCandidate(candidate);
    if (!command || (command !== "muse" && !fs.existsSync(command))) continue;
    try {
      const { stdout, stderr } = await execFileAsync(command, ["--version"], { timeout: 15_000 });
      const text = `${stdout}\n${stderr}`.trim();
      const match = /^Muse Code\s+(\S+)\s+\(([^)]+)\)/im.exec(text);
      if (!match) {
        failures.push(`${command}: unrecognised --version output ${JSON.stringify(text.slice(0, 100))}`);
        continue;
      }
      return { command, version: match[1], release: match[2] };
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new EnvironmentBlockedError(
    "Muse Code CLI가 설치되어 있지 않습니다.",
    "harness.muse",
    "Muse Code was not found. Install it with `irm https://dev.meta.ai/install.ps1 | iex` " +
      "(Windows) or `curl -fsSL https://dev.meta.ai/install.sh | bash`, then run `muse login`. " +
      `Tried: ${failures.join("; ") || "no candidates"}. No fallback was attempted.`,
  );
}

export function museCliInstalledPath(explicit?: string): string | undefined {
  for (const candidate of candidatePaths(explicit)) {
    const command = normalizeCandidate(candidate);
    if (command && (command === "muse" || fs.existsSync(command))) return command;
  }
  return undefined;
}
