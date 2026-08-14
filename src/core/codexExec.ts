import * as path from "node:path";

/**
 * Shared codex CLI spawn helpers used by the Codex adapter (chat sessions) and
 * the model discovery probe, so both resolve the binary and extra args the same
 * way (`AGENTPARTY_CODEX_BIN` / `AGENTPARTY_CODEX_ARGS` overrides included).
 */

/**
 * Resolves how to spawn the codex executable. A bare command name on Windows
 * (e.g. `codex` installed by npm) is a `.cmd` shim: `spawn` can't find the bare
 * name (ENOENT) and Node refuses to run a `.cmd` directly (EINVAL) — so let the
 * shell resolve it via PATHEXT. Explicit native executables are spawned
 * directly; explicit `.cmd`/`.bat` shims still require the shell.
 */
export function resolveCodexExecutable(executable: string): { command: string; shell: boolean } {
  const extension = path.extname(executable).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    return { command: executable, shell: true };
  }
  if (executable.includes("/") || executable.includes("\\") || path.extname(executable)) {
    return { command: executable, shell: false };
  }
  return { command: executable, shell: process.platform === "win32" };
}

/** The codex executable to spawn: explicit option, env override, or PATH. */
export function codexExecutable(executablePath?: string): string {
  return executablePath || process.env.AGENTPARTY_CODEX_BIN || "codex";
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
