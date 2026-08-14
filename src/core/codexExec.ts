import * as path from "node:path";
import { isFile, resolveOnPath, resolveWindowsNpmCommand } from "./commandProbe";

export interface ResolvedCodexExecutable {
  command: string;
  argsPrefix: string[];
  shell: boolean;
}

/**
 * Shared codex CLI spawn helpers used by the Codex adapter (chat sessions) and
 * the model discovery probe, so both resolve the binary and extra args the same
 * way (`AGENTPARTY_CODEX_BIN` / `AGENTPARTY_CODEX_ARGS` overrides included).
 */

/**
 * Resolves how to spawn the codex executable. A bare command name on Windows
 * (e.g. `codex` installed by npm) is a `.cmd` shim: `spawn` can't find the bare
 * name (ENOENT) and Node refuses to run a `.cmd` directly (EINVAL) — so let the
 * shell resolve a bare name only as a last resort. A concrete npm `.cmd` shim
 * is resolved to its JavaScript entrypoint and Node, keeping every later model,
 * MCP and workspace argument out of a shell command line.
 */
export function resolveCodexExecutable(executable: string): ResolvedCodexExecutable {
  const extension = path.extname(executable).toLowerCase();
  const windowsShim = extension === ".cmd" || extension === ".bat";
  if (process.platform === "win32" && windowsShim) {
    const entrypoint = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (isFile(entrypoint)) {
      return {
        command: resolveOnPath("node.exe") || "node",
        argsPrefix: [entrypoint],
        shell: false,
      };
    }
  }
  const bare = !executable.includes("/") && !executable.includes("\\") && !extension;
  return { command: executable, argsPrefix: [], shell: process.platform === "win32" && (bare || windowsShim) };
}

/** The codex executable to spawn: explicit option, env override, or PATH. */
export function codexExecutable(executablePath?: string): string {
  const configured = executablePath || process.env.AGENTPARTY_CODEX_BIN;
  if (configured) {
    return configured;
  }
  return resolveOnPath("codex") || resolveWindowsNpmCommand("codex") || "codex";
}

/** Extra args before `app-server`: explicit option or JSON array in env. */
export function codexExtraArgs(executableArgs?: string[]): string[] {
  if (executableArgs) {
    return executableArgs;
  }
  const raw = process.env.AGENTPARTY_CODEX_ARGS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
