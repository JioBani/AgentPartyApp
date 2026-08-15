/**
 * App self-update — the contract shared by main, preload, renderer and QA.
 *
 * Releases are published to a PUBLIC repository that is separate from the
 * (private) source repo, so the updater can fetch `latest.yml` and the NSIS
 * installer anonymously. No token is ever shipped in the app.
 */

/** Where the updater looks for releases. Must match `build.publish` in package.json. */
export const UPDATE_FEED = {
  provider: "github",
  owner: "JioBani",
  repo: "AgentParty-releases",
} as const;

/**
 * Where the update stands right now.
 *
 * `disabled` is NOT an error: a dev run or a portable build genuinely cannot
 * self-update, and saying so is better than pretending a check succeeded.
 */
export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  | "disabled";

export interface UpdateProgress {
  /** 0–100. */
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateStatus {
  state: UpdateState;
  /** Version this process is running. */
  currentVersion: string;
  /** Version offered by the feed, once a check has seen one. */
  latestVersion?: string;
  /** Release body (markdown) as published on GitHub. */
  releaseNotes?: string;
  /** ISO date the release was published. */
  releaseDate?: string;
  /** Human-visitable release page — the fallback when in-app install is off. */
  releaseUrl?: string;
  /** Present only while `state === "downloading"`. */
  progress?: UpdateProgress;
  /** Why the last check or download failed. Set with `state === "error"`. */
  error?: string;
  /** Why self-update is unavailable. Set with `state === "disabled"`. */
  disabledReason?: string;
  /** ISO stamp of the last completed check, successful or not. */
  checkedAt?: string;
  /**
   * The offered version is OLDER than the running one — the feed rolled back.
   * Set so the UI can say "되돌리기" instead of "새 버전": calling a rollback an
   * update is a lie the user acts on.
   */
  downgrade?: boolean;
}

/**
 * `-1 | 0 | 1` for `a` against `b`, on the dotted-numeric part of a version,
 * with a prerelease (`1.0.0-beta.1`) ranking below its release (`1.0.0`).
 *
 * Enough for "is the offered version older than mine", which is all we ask of
 * it. electron-updater does the authoritative comparison for the update itself.
 */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core, pre] = String(value || "0").split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre: pre || "" };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] || 0) - (right.parts[i] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  // No prerelease tag outranks any prerelease of the same core version.
  if (!left.pre) {
    return 1;
  }
  if (!right.pre) {
    return -1;
  }
  return left.pre > right.pre ? 1 : -1;
}

/**
 * One published release, as the 버전 tab lists it. Notes here are the RAW
 * markdown the author wrote (GitHub's REST `body`), unlike the rendered HTML
 * the updater hands over — see {@link releaseNotesToMarkdown}.
 */
export interface ReleaseSummary {
  /** Version without the leading "v" (0.2.0), matching `UpdateStatus.currentVersion`. */
  version: string;
  /** Release title as published; falls back to the tag. */
  name: string;
  /** Release body (markdown). Empty when the author published without notes. */
  notes: string;
  /** ISO publish stamp. */
  publishedAt: string;
  /** Human-visitable release page. */
  url: string;
  prerelease: boolean;
  /** True for the version this app is running — the list marks it. */
  current?: boolean;
}

/** `v0.2.0` → `0.2.0`. Tolerates a tag that already lacks the prefix. */
export function versionFromTag(tag: string): string {
  return String(tag || "").replace(/^v/i, "");
}

/** The tag convention used by electron-builder's GitHub publisher. */
export function releaseTagUrl(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases/tag/${tag}`;
}

export function releasesUrl(): string {
  return `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases`;
}

export function initialUpdateStatus(currentVersion: string): UpdateStatus {
  return { state: "idle", currentVersion };
}

/**
 * True when there is a new version the user can act on — the single predicate
 * the titlebar indicator keys off, so "is there a badge" is decided in one
 * place rather than re-derived per view.
 */
export function hasActionableUpdate(status: UpdateStatus | undefined): boolean {
  if (!status) {
    return false;
  }
  return status.state === "available" || status.state === "downloading" || status.state === "downloaded";
}

/** Short label for the titlebar pill. Empty string means "show nothing". */
export function updatePillLabel(status: UpdateStatus | undefined): string {
  if (!status) {
    return "";
  }
  switch (status.state) {
    case "available":
      return status.downgrade
        ? `되돌리기 ${status.latestVersion || ""}`.trim()
        : `업데이트 ${status.latestVersion || ""}`.trim();
    case "downloading":
      return `다운로드 ${Math.round(status.progress?.percent || 0)}%`;
    case "downloaded":
      return "재시작하여 설치";
    default:
      return "";
  }
}

/**
 * GitHub hands release notes over as RENDERED HTML, not the markdown that was
 * typed — so the dialog, which renders markdown, would print the tags as text.
 * This turns the handful of tags GitHub actually emits back into markdown and
 * drops the rest.
 *
 * Converting (rather than rendering the HTML) is deliberate: the notes are
 * remote text, and injecting remote HTML into the renderer is exactly the hole
 * we do not want for a string fetched over the network.
 *
 * Input that carries no tags is already markdown and is returned untouched.
 */
export function releaseNotesToMarkdown(raw: string): string {
  const text = String(raw || "");
  if (!/<[a-z][^>]*>/i.test(text)) {
    return text;
  }
  let out = text.replace(/\r\n?/g, "\n");
  // Lists first: the item markers depend on their container.
  out = out.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_all, inner: string) =>
    `\n${inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, item: string) => `1. ${item.trim()}\n`)}\n`);
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_all, item: string) => `- ${item.trim()}\n`);
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_all, level: string, body: string) =>
    `\n${"#".repeat(Math.min(6, Number(level) || 2))} ${body.trim()}\n`);
  out = out.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) =>
    `[${label.trim()}](${href})`);
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_all, _tag: string, body: string) => `**${body.trim()}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_all, _tag: string, body: string) => `*${body.trim()}*`);
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_all, body: string) => `\`${body.trim()}\``);
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/p>/gi, "\n\n").replace(/<p[^>]*>/gi, "");
  // Anything left (div, span, img, …) is structure we have no use for.
  out = out.replace(/<[^>]+>/g, "");
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&amp;/gi, "&");
  out = out.replace(/\n{3,}/g, "\n\n");
  // Keep list items adjacent: a blank line between them makes markdown render a
  // "loose" list, which double-spaces every bullet in the dialog.
  out = out.replace(/^((?:- |\d+\. )[^\n]*)\n{2,}(?=(?:- |\d+\. ))/gm, "$1\n");
  return out.trim();
}

/** Bytes → "12.3 MB", for the download progress line. */
export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(1)} ${units[unit]}`;
}
