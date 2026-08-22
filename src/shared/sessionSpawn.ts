/**
 * The session-start event, as the USER is allowed to see it.
 *
 * A member starting up used to reach the transcript as a raw status line —
 * `spawned: C:\Program Files\nodejs\node.exe … app-server -c mcp_servers.…` —
 * which is the whole spawn command: an absolute executable path, every CLI
 * argument, the party MCP wiring with its automation URL and local port, the
 * party/member identifiers, and the auth-store settings. None of that is
 * information the person reading a conversation asked for, and all of it is
 * internal plumbing that should never have been on a user surface.
 *
 * So the adapters emit a STRUCTURED start event instead (mirroring what
 * `compact_state` did for compaction), and this module owns the two halves of
 * keeping it safe:
 *
 *  - {@link SessionSpawnFacts}: the small, deliberately closed set of fields a
 *    spawn card may show. Nothing else travels — a field that does not exist
 *    cannot leak into a card body or a tooltip.
 *  - the redaction helpers below, which are what a raw string has to pass
 *    through before any of it is shown: `spawnFailureSummary` for an error, and
 *    the legacy helpers for the raw lines already sitting in transcripts that
 *    were persisted before this change.
 *
 * Raw spawn detail is still written to the per-session debug log by each
 * adapter (`this.log("spawn_…", …)`), which is a separate surface the user
 * opens on purpose. This module is only about the conversation feed.
 */

/** How far a start attempt has got. Terminal: `running` and `failed`. */
export type SessionSpawnState = "starting" | "running" | "failed";

/** The complete set of facts a session-spawn card may carry. */
export interface SessionSpawnFacts {
  state: SessionSpawnState;
  /** Harness id (`claude-code` | `codex` | `cursor` | `grok`), for the label. */
  harness?: string;
  /** Effective model name. Already user-facing everywhere else in the UI. */
  model?: string;
  /** Which side of the machine the member runs on. */
  host?: "windows" | "wsl";
  /**
   * Working directory, ALREADY shortened for display by {@link shortCwd}. The
   * full path never travels: it is both noise on a card and, in a screenshared
   * window, information the user did not choose to show.
   */
  cwd?: string;
  /** Redacted failure summary (`failed` only) — never a command or a path. */
  reason?: string;
  /** Whether starting again is worth attempting (`failed` only). */
  retryable?: boolean;
}

/**
 * The last one or two path segments, which is as much as a card needs to say
 * "which checkout is this". `C:\Users\me\work\app\src` becomes `…/app/src`.
 */
export function shortCwd(cwd: string | undefined): string {
  const raw = String(cwd || "").trim().replace(/[\\/]+$/, "");
  if (!raw) {
    return "";
  }
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) {
    return parts[0] || raw;
  }
  const tail = parts.slice(-2).join("/");
  // Two segments IS the whole path here, so it gets no ellipsis.
  return parts.length > 2 ? `…/${tail}` : tail;
}

/** Anything that looks like machinery rather than a sentence. */
const LEAKY_PATTERNS: RegExp[] = [
  // Quoted arguments — a Windows path with spaces ("C:\Program Files\…")
  // outlives a whitespace-bounded pattern, and quoting is how it gets there.
  /"[^"]*"/g,
  /'[^']*'/g,
  // Executables and scripts by extension, wherever the path broke apart.
  /\S*\.(?:exe|cmd|bat|ps1|sh|mjs|cjs|js)\b/gi,
  // Windows / UNC / POSIX absolute paths.
  /[A-Za-z]:[\\/][^\s"']*/g,
  /\\\\[^\s"']+/g,
  /(?:^|[\s"'(=])\/(?:[^\s"'()]+\/)+[^\s"'()]*/g,
  // URLs and host:port pairs (the party automation endpoint and its local port).
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi,
  /\blocalhost(?::\d+)?\b/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g,
  /:\d{2,5}\b/g,
  // CLI arguments and TOML/env assignments (`-c mcp_servers.x.env.Y=Z`).
  /(?:^|\s)-{1,2}[A-Za-z][\w.-]*(?:=\S+)?/g,
  /\b[A-Z][A-Z0-9_]{3,}=\S*/g,
  /\b[\w.]*(?:mcp_servers|api[_-]?key|token|secret|auth)[\w.]*\S*/gi,
  // Party/member identifiers (`party-1787322541208-e5ed…`) and bare uuids.
  /\bparty-[\w-]+/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

/** Known process-level failures, said in a way a user can act on. */
const FAILURE_RULES: Array<{ match: RegExp; reason: string; retryable: boolean }> = [
  { match: /\bENOENT\b|not found|command not found/i, reason: "하네스 실행 파일을 찾지 못했습니다. 설치 상태를 확인하세요.", retryable: false },
  { match: /\bEACCES\b|\bEPERM\b|permission denied/i, reason: "실행 권한이 없어 시작하지 못했습니다.", retryable: false },
  { match: /\bETIMEDOUT\b|timed ?out/i, reason: "시작이 시간 내에 끝나지 않았습니다.", retryable: true },
  { match: /\bECONNREFUSED\b|\bECONNRESET\b|\bEPIPE\b/i, reason: "하네스와 연결이 끊겨 시작하지 못했습니다.", retryable: true },
  { match: /auth|login|sign ?in|credential|unauthor/i, reason: "로그인이 필요해 시작하지 못했습니다.", retryable: false },
  { match: /\bEADDRINUSE\b/i, reason: "필요한 로컬 자원이 이미 사용 중입니다.", retryable: true },
];

/** Shown when nothing recognizable survives classification. */
const GENERIC_FAILURE = "세션을 시작하지 못했습니다.";

/**
 * Turns a harness error into a one-line summary safe to show.
 *
 * Classification comes FIRST and the raw text is then discarded: a matched rule
 * returns its own fixed sentence, so no part of the original string — which is
 * routinely the whole spawn command plus the OS error — can ride along. An
 * unmatched error falls back to a generic line rather than to "show it anyway".
 */
export function spawnFailureSummary(error: unknown): { reason: string; retryable: boolean } {
  const raw = errorText(error);
  for (const rule of FAILURE_RULES) {
    if (rule.match.test(raw)) {
      return { reason: rule.reason, retryable: rule.retryable };
    }
  }
  const exit = /exit(?:ed)?(?: with)? code (\d+)/i.exec(raw);
  if (exit) {
    return { reason: `하네스가 시작 중 종료되었습니다 (코드 ${exit[1]}).`, retryable: true };
  }
  return { reason: GENERIC_FAILURE, retryable: true };
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name} ${error.message} ${String((error as NodeJS.ErrnoException).code || "")}`;
  if (typeof error === "object") {
    const value = error as { message?: unknown; code?: unknown };
    return `${String(value.message ?? "")} ${String(value.code ?? "")}`;
  }
  return String(error);
}

/**
 * Statuses that used to carry spawn plumbing as their `detail`.
 *
 * The adapters no longer emit them, but transcripts persisted before this
 * change do, and a restore replays those blocks verbatim.
 */
export const SPAWN_STATUSES = new Set(["spawned", "spawning"]);

/**
 * Whether a persisted status line is a raw spawn line from an older transcript.
 *
 * Matches the persisted shape `"<status>: <detail>"`, and only for the statuses
 * that ever carried spawn plumbing — so an ordinary status line, a tool result
 * that happens to mention a command, or a user message is never mistaken for a
 * session card.
 */
export function isLegacySpawnLine(text: string | undefined): boolean {
  const value = String(text || "");
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return false;
  }
  return SPAWN_STATUSES.has(value.slice(0, separator).trim());
}

/**
 * The facts a legacy `spawned: …` line may still contribute to a card.
 *
 * The detail is DROPPED rather than scrubbed: a regex trying to clean a command
 * line is not a safety boundary. All that survives is what the old line
 * actually meant to a reader — a session started here — so a restored history
 * shows the same card as a live start, with the fields it cannot know left out.
 */
export function legacySpawnFacts(): SessionSpawnFacts {
  return { state: "running" };
}

/**
 * Which side of the machine this process runs on.
 *
 * A WSL member is served by an engine running INSIDE the distro, so the adapter
 * asking is already on the side it is reporting — no path sniffing needed, and
 * nothing about the path reaches the card either way.
 */
export function currentSpawnHost(): "windows" | "wsl" | undefined {
  if (typeof process === "undefined" || !process?.platform) {
    return undefined;
  }
  return process.platform === "win32" ? "windows" : "wsl";
}

/** Strips machinery out of an arbitrary string. Defense in depth, not the primary guard. */
export function redactSpawnText(text: string | undefined): string {
  let value = String(text || "");
  for (const pattern of LEAKY_PATTERNS) {
    value = value.replace(pattern, " ");
  }
  return value.replace(/\s{2,}/g, " ").trim();
}
