/**
 * Deciding whether a member can actually run in a directory.
 *
 * The rule this file exists to enforce (README §12): a location is checked in
 * the environment the member will RUN in, never from the side. Windows can list
 * `\\wsl$\Ubuntu\srv` through a network redirector while the distro itself
 * refuses to start, so a `fs.existsSync` on that path answers a question nobody
 * asked. A WSL location is therefore probed with `wsl.exe -d <distro>`, and the
 * failure that comes back is reported as the reason it failed rather than
 * collapsed into "unavailable".
 *
 * Nothing here ever substitutes a working directory for a broken one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { probeCommand } from "../core/commandProbe";
import { getUserDataDir } from "./userDataDir";
import { listWslDistros } from "./environmentService";
import {
  checkLocationShape,
  cwdProblem,
  parseMemberLocation,
  serializeMemberLocation,
  type CwdProblem,
  type ExecutionEnv,
  type MemberExecutionLocation,
} from "../shared/memberLocation";
import { log } from "./logger";

/** A location plus the verdict on it. `problem` absent = usable right now. */
export interface CwdCheck {
  location: MemberExecutionLocation;
  /** The serialized form, so a caller can store what it just validated. */
  serialized: string;
  problem?: CwdProblem;
}

const WSL_PROBE_TIMEOUT_MS = 20_000;

/**
 * Checks one location where it lives.
 *
 * Shape first (cheap, and a relative path can never be right), then existence:
 * `fs.statSync` for Windows, a `test -d` inside the distro for WSL.
 */
export async function checkCwd(location: MemberExecutionLocation): Promise<CwdCheck> {
  const serialized = serializeMemberLocation(location);
  const shape = checkLocationShape(location);
  if (shape) {
    return { location, serialized, problem: shape };
  }
  const problem = location.env === "wsl"
    ? await checkWslCwd(location.distro as string, location.cwd)
    : checkWindowsCwd(location.cwd);
  if (problem) {
    log("info", "cwd", "location unusable", { location: serialized, kind: problem.kind });
  }
  return { location, serialized, problem };
}

/** Convenience for callers holding the stored string rather than the pair. */
export function checkCwdString(value: string): Promise<CwdCheck> {
  return checkCwd(parseMemberLocation(value));
}

function checkWindowsCwd(cwd: string): CwdProblem | undefined {
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return cwdProblem("missing");
    }
  } catch (error) {
    // ENOENT and EACCES are different repairs — one needs a different folder,
    // the other needs permission — so they are not merged into one message.
    return cwdProblem((error as NodeJS.ErrnoException)?.code === "EACCES" ? "denied" : "missing");
  }
  try {
    fs.accessSync(cwd, fs.constants.R_OK);
  } catch {
    return cwdProblem("denied");
  }
  return undefined;
}

/**
 * Probes a POSIX path INSIDE the distro.
 *
 * The three failures are told apart because they need different repairs:
 * the distro is not installed, the distro will not start, or the path is not
 * there. `wsl.exe` reports the first two the same way (a non-zero exit with a
 * message on stderr), so the installed list is consulted first.
 */
async function checkWslCwd(distro: string, cwd: string): Promise<CwdProblem | undefined> {
  const { names, error } = await listWslDistros();
  if (error) {
    return cwdProblem("distro-unavailable");
  }
  if (!names.some((name) => name.toLowerCase() === distro.toLowerCase())) {
    return cwdProblem("distro-missing");
  }
  // `test -d` alone cannot separate "distro did not boot" from "no such path":
  // both exit non-zero. So the probe prints a marker on success and a distinct
  // one when it ran but found nothing, and anything else is a boot failure.
  const probe = await probeCommand(
    "wsl.exe",
    ["-d", distro, "-e", "sh", "-lc", `if [ -d "${shellQuote(cwd)}" ]; then if [ -r "${shellQuote(cwd)}" ]; then echo __AP_OK__; else echo __AP_DENIED__; fi; else echo __AP_MISSING__; fi`],
    { timeoutMs: WSL_PROBE_TIMEOUT_MS },
  );
  const out = probe.stdout.replace(/\0/g, "");
  if (out.includes("__AP_OK__")) {
    return undefined;
  }
  if (out.includes("__AP_DENIED__")) {
    return cwdProblem("denied");
  }
  if (out.includes("__AP_MISSING__")) {
    return cwdProblem("missing");
  }
  // No marker at all: the shell never ran. That is the distro, not the path.
  return { ...cwdProblem("distro-unavailable"), message: wslFailureMessage(probe.error) };
}

/**
 * Keeps a path with a quote in it from ending the shell string.
 *
 * The path comes from a folder picker or the user's own typing, and both can
 * contain a `'`; without this the probe would be a broken command reported as
 * "distro will not start".
 */
function shellQuote(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

function wslFailureMessage(error: string | undefined): string {
  const detail = String(error || "").trim().split(/\r?\n/)[0];
  return detail ? `배포판을 시작할 수 없음 — ${detail}` : "배포판을 시작할 수 없음";
}

/** Installed distros, for the WSL side of the cwd picker. */
export async function wslDistros(): Promise<{ names: string[]; error?: string }> {
  if (process.platform !== "win32") {
    return { names: [], error: "WSL은 Windows에서만 사용할 수 있습니다." };
  }
  return listWslDistros();
}

/**
 * Turns a folder the Windows picker returned into the right kind of location.
 *
 * A `\\wsl$\<distro>\...` pick IS a WSL location, and storing it as a Windows
 * path would run the member through the network redirector instead of inside
 * the distro. `parseMemberLocation` already knows that spelling, so the picker
 * does not need a second rule about it.
 */
export function locationFromPickedFolder(folder: string, requested: ExecutionEnv): MemberExecutionLocation {
  const parsed = parseMemberLocation(folder);
  if (parsed.env === "wsl") {
    return parsed;
  }
  // A Windows path picked while the WSL side was selected is NOT silently
  // converted: `/mnt/c/...` is a guess about how that distro is mounted.
  return requested === "wsl" ? { env: "wsl", cwd: folder } : parsed;
}

/**
 * The distro's `$HOME`, as the distro itself reports it.
 *
 * Used to point the folder dialog at `\wsl$\<distro>\home\<user>` instead of
 * the distro root: `/` opens onto `proc`, `sys` and `mnt`, a first screen made
 * of directories nobody wanted. Asking the distro beats guessing `/home/<user>`,
 * which is wrong for root and for any account with a moved home.
 *
 * A distro that will not start answers with a `problem` rather than a guess —
 * opening a dialog on an unreachable UNC path shows an empty window with no
 * explanation.
 */
export async function wslHome(distro: string): Promise<{ home?: string; problem?: CwdProblem }> {
  const probe = await probeCommand(
    "wsl.exe",
    // `echo`, not `printf`: no escape to get wrong on the way through three
    // quoting layers, and the marker keeps a login banner out of the way.
    ["-d", distro, "-e", "sh", "-lc", 'echo "__AP_HOME__$HOME"'],
    { timeoutMs: WSL_PROBE_TIMEOUT_MS },
  );
  const home = probe.stdout.replace(/\0/g, "").split(/\r?\n/)
    .find((line) => line.startsWith("__AP_HOME__"))?.slice("__AP_HOME__".length).trim();
  if (home) {
    return { home };
  }
  // No marker: the shell never ran. Tell "not installed" from "will not start",
  // because they need different repairs.
  const { names, error } = await listWslDistros();
  if (!error && !names.some((name) => name.toLowerCase() === distro.toLowerCase())) {
    return { problem: cwdProblem("distro-missing") };
  }
  log("info", "cwd", "wsl home lookup failed", { distro, error: probe.error });
  return { problem: { ...cwdProblem("distro-unavailable"), message: wslFailureMessage(probe.error) } };
}

/**
 * The folder the app offers when the user has no recent and no default cwd.
 *
 * Under `userData` next to the rest of the app's own state, so a first run has
 * somewhere real to put a party without asking the user to go find a directory
 * first. Created here rather than at the moment of use: a suggested path that
 * does not exist would be refused by the very check that guards creation.
 */
export function appWorkspaceRoot(): string {
  const root = path.join(getUserDataDir(), "workspaces");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    // Reported, not swallowed: without it the picker offers a path that cannot
    // be used, and the failure would surface later as a confusing refusal.
    log("warn", "cwd", "could not create the app workspace folder", { root, error: error instanceof Error ? error.message : String(error) });
  }
  return root;
}
