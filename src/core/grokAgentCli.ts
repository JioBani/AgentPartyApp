/**
 * Locating and vetting the official Grok Build CLI (`grok`).
 *
 * Two things make this more than a PATH lookup:
 *
 *  - A community package (`grok-dev`) installs a DIFFERENT binary under the
 *    same name into ~/.grok/bin, and version numbers no longer separate them
 *    (official is 1.0.0, the community one 1.1.7 as of 2026-08-10). The
 *    official build prints a commit hash after the version and ships an
 *    `inspect` subcommand, so identity is decided on those rather than on a
 *    version range that will drift.
 *
 *  - Windows installs to %LOCALAPPDATA% or ~/.grok/bin, neither of which is
 *    reliably on the PATH of a GUI-launched Electron process.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GrokCliInfo {
  command: string;
  version: string;
  /** The commit hash the official build prints; absent on look-alikes. */
  commit?: string;
}

function candidatePaths(explicit?: string): string[] {
  const exe = process.platform === "win32" ? "grok.exe" : "grok";
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA;
  return [
    explicit,
    process.env.AGENTPARTY_GROK_BIN,
    path.join(home, ".grok", "bin", exe),
    local ? path.join(local, "grok", "bin", exe) : undefined,
    local ? path.join(local, "Programs", "grok", exe) : undefined,
    "grok",
  ].filter((entry): entry is string => Boolean(entry));
}

/**
 * The first candidate that runs and identifies as the official build.
 *
 * Throws rather than returning undefined: a Grok Build member with no binary
 * must fail visibly at start, not degrade into some other harness.
 */
export async function resolveGrokCli(explicit?: string): Promise<GrokCliInfo> {
  const tried: string[] = [];
  for (const command of candidatePaths(explicit)) {
    if (command !== "grok" && !fs.existsSync(command)) {
      continue;
    }
    try {
      const { stdout } = await execFileAsync(command, ["--version"], { timeout: 15_000 });
      const text = stdout.trim();
      const match = /^grok\s+(\S+)(?:\s+\(([0-9a-f]{6,})\))?/i.exec(text);
      if (!match) {
        tried.push(`${command}: unrecognised --version output ${JSON.stringify(text.slice(0, 60))}`);
        continue;
      }
      const [, version, commit] = match;
      if (!commit) {
        tried.push(
          `${command}: reports "${text.slice(0, 40)}" with no commit hash — this looks like the community ` +
            "`grok-dev` package, which installs a different agent under the same name",
        );
        continue;
      }
      return { command, version, commit };
    } catch (error) {
      tried.push(`${command}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(
    "The official Grok Build CLI was not found. Install it with `irm https://x.ai/cli/install.ps1 | iex` " +
      "(Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`, then run `grok login`. " +
      `Tried: ${tried.join("; ") || "no candidates"}. No fallback was attempted.`,
  );
}

/**
 * Where the `grok` binary sits, without running it.
 *
 * The Authentication view builds synchronously, so it cannot await the
 * `--version` probe {@link resolveGrokCli} uses to tell the official build from
 * the same-named community one. This answers the weaker question the settings
 * screen actually asks — "is it installed at all" — and start-up still does the
 * full identity check before spawning anything.
 */
export function grokCliInstalledPath(explicit?: string): string | undefined {
  for (const candidate of candidatePaths(explicit)) {
    if (candidate !== "grok" && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Environment for a Grok Build child.
 *
 * `--no-auto-update` is a GLOBAL flag and must precede the subcommand, which is
 * why argument order is fixed here rather than left to callers.
 */
export function grokAgentStdioArgs(): string[] {
  return ["--no-auto-update", "agent", "stdio"];
}
