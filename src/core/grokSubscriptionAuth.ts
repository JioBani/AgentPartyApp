/**
 * Reads the xAI subscription credential that the official Grok Build CLI
 * (`grok login`) already wrote, so a Claude Code member can run Grok models on
 * the user's SuperGrok / X Premium+ subscription instead of console credits.
 *
 * READ-ONLY, deliberately. The refresh token in `auth.json` is single-use and
 * rotates; the official CLI serialises refreshes behind `auth.json.lock`. A
 * second writer racing it invalidates the user's login — a failure mode several
 * OSS bridges shipped and then had to design around. We therefore never
 * refresh, never write, and simply surface an actionable error once the access
 * token expires, leaving `grok` itself as the only mutator of the file.
 *
 * The file is re-read whenever its mtime changes, so a refresh performed by the
 * CLI is picked up on the next request without restarting the app.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EnvironmentBlockedError, isEnvironmentBlockedError } from "./environmentError";

/** Where `grok` keeps its state; GROK_HOME overrides, matching the CLI. */
export function grokHomeDir(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function authFilePath(): string {
  return path.join(grokHomeDir(), "auth.json");
}

export interface GrokSubscriptionCredential {
  accessToken: string;
  /** Absent when the file carries no expiry; treated as "unknown, try it". */
  expiresAt?: Date;
  email?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  credential: GrokSubscriptionCredential;
}

let cache: CacheEntry | undefined;

/**
 * `auth.json` is keyed by an opaque scope url ("https://auth.x.ai::<clientId>")
 * whose value holds the tokens, so the shape is walked rather than indexed. A
 * fixed path would break the moment xAI adds a second scope or renames one.
 */
function findCredential(root: unknown, depth = 0): GrokSubscriptionCredential | undefined {
  if (depth > 4 || !root || typeof root !== "object") {
    return undefined;
  }
  const node = root as Record<string, unknown>;
  if (typeof node.key === "string" && node.key.length > 0) {
    const expiresRaw = typeof node.expires_at === "string" ? node.expires_at : undefined;
    const expiresAt = expiresRaw ? new Date(expiresRaw) : undefined;
    return {
      accessToken: node.key,
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : undefined,
      email: typeof node.email === "string" ? node.email : undefined,
    };
  }
  for (const value of Object.values(node)) {
    const found = findCredential(value, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export class GrokSubscriptionAuthError extends Error {}

/**
 * The current subscription access token.
 *
 * Throws with a fix-it message rather than returning undefined: a Grok member
 * that cannot authenticate must fail visibly, not fall back to another
 * provider or to console-credit billing.
 */
export function grokSubscriptionToken(): GrokSubscriptionCredential {
  const file = authFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // Not signed in is the ONE Grok failure the user fixes with a single
    // command, so it travels as an environment blocker (card + `grok login`
    // button) rather than as prose. Expiry below stays a plain auth error: the
    // CLI refreshes it on its own next run.
    throw new EnvironmentBlockedError(
      "Grok에 로그인되어 있지 않습니다.",
      "harness.grok",
      `Grok is not signed in on this machine (${file} not found). Install the official CLI ` +
        "from https://x.ai/cli/install.ps1 and run `grok login`. No fallback was attempted.",
    );
  }

  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return assertFresh(cache.credential);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new GrokSubscriptionAuthError(
      `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}. Run \`grok login\` to rewrite it.`,
    );
  }

  const credential = findCredential(parsed);
  if (!credential) {
    throw new GrokSubscriptionAuthError(
      `${file} carries no access token. Run \`grok login\` to sign in again.`,
    );
  }
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, credential };
  return assertFresh(credential);
}

/**
 * Expiry is enforced here instead of letting xAI answer 401, because the fix
 * (`grok login`, or simply running `grok` so it refreshes under its own lock)
 * is something only the user can do and the 401 body does not say so.
 */
function assertFresh(credential: GrokSubscriptionCredential): GrokSubscriptionCredential {
  if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
    throw new GrokSubscriptionAuthError(
      `The Grok subscription token expired at ${credential.expiresAt.toISOString()}. ` +
        "Run any `grok` command (for example `grok models`) to let the official CLI refresh it, or `grok login` to sign in again. " +
        "AgentParty deliberately does not refresh this token itself — the refresh token is single-use and rotating, " +
        "so a second writer would invalidate your CLI login.",
    );
  }
  return credential;
}

/**
 * Whether a Grok subscription credential is usable right now (for UI/status).
 *
 * `reason` is the sentence to show; `raw` is the untranslated original (paths,
 * expiry timestamps) when there is one. Both are returned because collapsing
 * them loses exactly the detail a bug report needs.
 */
export function grokSubscriptionAvailable(): { ok: true; email?: string } | { ok: false; reason: string; raw?: string } {
  try {
    const credential = grokSubscriptionToken();
    return { ok: true, email: credential.email };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      ...(isEnvironmentBlockedError(error) && error.raw ? { raw: error.raw } : {}),
    };
  }
}
