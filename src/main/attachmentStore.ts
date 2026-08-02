/**
 * Persists user-turn attachments as REAL FILES the session can open.
 *
 * Attachments used to travel as base64 bytes only, so a model asked to "move
 * this image somewhere" was right to refuse: nothing existed on disk. Writing
 * the bytes down and handing over the path turns the image into an ordinary
 * file the harness's own file tools can act on.
 *
 * Two decisions carry the design (see docs/ATTACHMENT_POLICY.md):
 *
 *  - Files live INSIDE the workspace (`.agent_party_app/attachments/<YYYY-MM>/`).
 *    A temp folder outside the cwd can be refused by a harness permission
 *    policy, which yields the worst outcome: the file exists but will not open.
 *
 *  - Nothing translates paths between hosts. This module runs inside whichever
 *    engine owns the session — the desktop process for a local member, the
 *    in-distro engine server for a WSL one — so `path.join` already produces a
 *    path native to the side that will read it. No translation, no translation
 *    bugs.
 */
import fs from "node:fs";
import path from "node:path";
import { base64ByteLength, type ImageAttachment } from "../shared/attachments";
import { log } from "./logger";

const ROOT_DIR = ".agent_party_app";
const ATTACHMENTS_DIR = "attachments";

/** Retention defaults; both are overridable through app settings. */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 30;
export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB

export interface AttachmentRetentionPolicy {
  maxAgeDays: number;
  maxBytes: number;
}

export const DEFAULT_ATTACHMENT_RETENTION: AttachmentRetentionPolicy = {
  maxAgeDays: DEFAULT_ATTACHMENT_RETENTION_DAYS,
  maxBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
};

/** What a prune actually removed — reported, never swallowed (R-17). */
export interface AttachmentPruneReport {
  removedCount: number;
  removedBytes: number;
  /** Why each file went, so the report can say more than "some files". */
  expiredCount: number;
  overQuotaCount: number;
}

export function attachmentsDir(workspacePath: string): string {
  return path.join(workspacePath, ROOT_DIR, ATTACHMENTS_DIR);
}

/** Workspaces already swept in this process — retention runs once per run. */
const swept = new Set<string>();

/**
 * Runs the retention sweep the first time a workspace is used in this process,
 * and returns a line to show the user when it removed anything.
 *
 * Lazy rather than scheduled, matching how `discovery` and the Discord claims
 * stay tidy. It RETURNS the line instead of logging it, so the caller can put it
 * where the user is actually looking: a removal announced only to a log file is
 * still a removal nobody was told about, and a transcript can go on naming a
 * path that no longer opens.
 */
export function sweepWorkspaceOnce(workspacePath: string, policy?: AttachmentRetentionPolicy): string | null {
  if (!workspacePath || swept.has(workspacePath)) {
    return null;
  }
  swept.add(workspacePath);
  let report: AttachmentPruneReport | null = null;
  try {
    report = pruneAttachments(workspacePath, policy);
  } catch (error) {
    log("warn", "attachment", "attachment retention sweep failed", {
      workspace: workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const line = describePruneReport(report);
  if (line && report) {
    log("info", "attachment", "attachment retention removed files", { workspace: workspacePath, ...report });
  }
  return line;
}

/** The effective policy from user settings, falling back to the defaults. */
export function retentionPolicyOf(settings?: {
  attachmentRetention?: { maxAgeDays: number; maxMegabytes: number };
}): AttachmentRetentionPolicy {
  const configured = settings?.attachmentRetention;
  if (!configured) {
    return DEFAULT_ATTACHMENT_RETENTION;
  }
  // 0 means "no limit on this axis", expressed as an unreachable bound rather
  // than a special case each call site would have to remember.
  return {
    maxAgeDays: configured.maxAgeDays > 0 ? configured.maxAgeDays : Number.POSITIVE_INFINITY,
    maxBytes: configured.maxMegabytes > 0 ? configured.maxMegabytes * 1024 * 1024 : Number.POSITIVE_INFINITY,
  };
}

/**
 * Writes one attachment into the workspace and returns its absolute path.
 *
 * Throws if the bytes cannot be written. The caller reports that and sends the
 * turn WITHOUT a path rather than pretending a file exists — a path that does
 * not open is worse than no path, because the model will act on it.
 */
export function saveAttachment(workspacePath: string, attachment: ImageAttachment, now = new Date()): string {
  const dir = path.join(attachmentsDir(workspacePath), monthFolder(now));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileNameFor(attachment, now));
  fs.writeFileSync(file, Buffer.from(attachment.dataBase64, "base64"));
  return file;
}

/**
 * Saves every attachment that is not already on disk, stamping `path` onto it.
 *
 * A turn replayed from the message queue arrives with `path` already set; it
 * keeps that file instead of being written a second time under a new name.
 * Failures are logged and left unstamped, so one bad write cannot take the
 * whole turn down with it.
 */
export function saveAttachments(
  workspacePath: string,
  attachments: ImageAttachment[] | undefined,
  now = new Date(),
): ImageAttachment[] | undefined {
  if (!attachments?.length || !workspacePath) {
    return attachments;
  }
  return attachments.map((attachment) => {
    if (attachment.path) {
      return attachment;
    }
    try {
      return { ...attachment, path: saveAttachment(workspacePath, attachment, now) };
    } catch (error) {
      log("error", "attachment", "could not save an attached image", {
        workspace: workspacePath,
        name: attachment.name,
        bytes: base64ByteLength(attachment.dataBase64),
        error: error instanceof Error ? error.message : String(error),
      });
      return attachment;
    }
  });
}

/**
 * Enforces the retention policy and reports what it removed.
 *
 * Age first, then the size cap oldest-first. Returns null when the folder does
 * not exist yet (nothing to say) — distinct from a prune that removed nothing,
 * which returns a zeroed report.
 *
 * The caller MUST surface a non-empty report. A transcript can still show the
 * path of a file removed here; if that removal is silent, the broken path
 * cannot be explained later.
 */
export function pruneAttachments(
  workspacePath: string,
  policy: AttachmentRetentionPolicy = DEFAULT_ATTACHMENT_RETENTION,
  now = Date.now(),
): AttachmentPruneReport | null {
  const root = attachmentsDir(workspacePath);
  if (!fs.existsSync(root)) {
    return null;
  }
  const files = listFiles(root);
  const report: AttachmentPruneReport = { removedCount: 0, removedBytes: 0, expiredCount: 0, overQuotaCount: 0 };

  const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1000;
  const survivors: FileEntry[] = [];
  for (const entry of files) {
    if (entry.mtimeMs < cutoff && remove(entry)) {
      report.removedCount += 1;
      report.removedBytes += entry.size;
      report.expiredCount += 1;
    } else {
      survivors.push(entry);
    }
  }

  // Oldest first, so the cap takes the least useful files.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of survivors) {
    if (total <= policy.maxBytes) {
      break;
    }
    if (remove(entry)) {
      total -= entry.size;
      report.removedCount += 1;
      report.removedBytes += entry.size;
      report.overQuotaCount += 1;
    }
  }

  pruneEmptyMonths(root);
  return report;
}

/** One line a person can read, or null when nothing was removed. */
export function describePruneReport(report: AttachmentPruneReport | null): string | null {
  if (!report || report.removedCount === 0) {
    return null;
  }
  const reasons = [
    report.expiredCount ? `보존 기간 초과 ${report.expiredCount}개` : "",
    report.overQuotaCount ? `용량 상한 초과 ${report.overQuotaCount}개` : "",
  ].filter(Boolean).join(", ");
  return `첨부 파일 ${report.removedCount}개(${formatBytes(report.removedBytes)})를 정리했습니다 — ${reasons}. 이전 대화에 남은 그 파일들의 경로는 이제 열리지 않습니다.`;
}

interface FileEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

function listFiles(root: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const month of readDir(root)) {
    const dir = path.join(root, month);
    for (const name of readDir(dir)) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) {
          entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Vanished between listing and stat — nothing to prune.
      }
    }
  }
  return entries;
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function remove(entry: FileEntry): boolean {
  try {
    fs.rmSync(entry.file, { force: true });
    return true;
  } catch (error) {
    log("warn", "attachment", "could not remove an expired attachment", {
      file: entry.file,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function pruneEmptyMonths(root: string): void {
  for (const month of readDir(root)) {
    const dir = path.join(root, month);
    if (readDir(dir).length === 0) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Housekeeping only.
      }
    }
  }
}

function monthFolder(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * A name that is unique, sorts by time, and keeps the original recognisable.
 * Everything unusual is replaced, so a pasted name cannot escape the folder or
 * produce a path the shell needs quoting for.
 */
function fileNameFor(attachment: ImageAttachment, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const unique = Math.random().toString(16).slice(2, 8);
  const source = path.basename(attachment.name || "");
  const ext = extensionFor(attachment.mediaType, source);
  const base = source.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${stamp}-${unique}${base ? `-${base}` : ""}${ext}`;
}

function extensionFor(mediaType: string, sourceName: string): string {
  const fromName = path.extname(sourceName).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) {
    return fromName;
  }
  const subtype = mediaType.split("/")[1] || "png";
  if (subtype === "jpeg") {
    return ".jpg";
  }
  if (subtype === "svg+xml") {
    return ".svg";
  }
  return `.${subtype.replace(/[^a-z0-9]/gi, "") || "png"}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
