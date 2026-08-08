import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PartyDefinition, PartyMember, PartyMessage, TranscriptSave, TranscriptSaveResult } from "../shared/types";
import { externalizeImages, extensionFor, TRANSCRIPT_IMAGE_DIR, type StoredImageSource } from "../shared/transcriptImages";
import { sanitizeLayout, type WorkbenchLayout } from "../shared/workbenchLayout";
import { log } from "./logger";

/**
 * The composed, in-memory party state — the shared party index PLUS every
 * party's own detail. It is assembled by {@link PartyRepository.read} from the
 * on-disk split layout (see below) and consumed exactly as before by the
 * service, so all `requireMember`/`view` logic is unchanged.
 *
 * On-disk layout under `<workspace>/.agent_party_app/` (version 2):
 *   - `parties.json`                    — SHARED index: `{ parties[], lastActivePartyId? }`
 *   - `parties/<id>/party.json`         — PER-PARTY detail: `{ members[], messages[] }`
 *   - `parties/<id>/members/<name>/transcript.json` — per-member transcript
 *
 * Splitting members/messages per party means two processes editing DIFFERENT
 * parties of the same workspace write different files and never clobber each
 * other. The party LIST is the only shared file, and it changes rarely
 * (create/rename/select/delete). `currentPartyId` is NOT persisted here — it is
 * per-process runtime; the index carries an advisory `lastActivePartyId` hint.
 */
export interface StoredPartyState {
  version: 2;
  parties: PartyDefinition[];
  /** Advisory "last active party" hint restored on load — NOT authoritative. */
  currentPartyId?: string;
  members: PartyMember[];
  messages: PartyMessage[];
}

interface PartyIndex {
  parties: PartyDefinition[];
  lastActivePartyId?: string;
}

interface PartyDetail {
  members: PartyMember[];
  messages: PartyMessage[];
}

const initialState: StoredPartyState = { version: 2, parties: [], members: [], messages: [] };

export class PartyRepository {
  /**
   * Mirror of each transcript file's last written blocks, keyed by file path.
   * Lets an anchored append resolve its anchor without re-reading and re-parsing
   * the file on every save. Safe because this process is the sole writer for its
   * workspace; a cold entry falls back to a real read.
   */
  private readonly lastWritten = new Map<string, unknown[]>();

  /**
   * Composes the whole party state from the shared index + each party's detail
   * file. Migrates a legacy single-blob `state.json` (new root or the older
   * `.agentparty/`) on first read. Never throws — a missing/corrupt store reads
   * as empty.
   */
  read(workspacePath: string): StoredPartyState {
    try {
      const index = this.readIndexFile(workspacePath);
      if (index) {
        return this.compose(workspacePath, index);
      }
      const legacy = this.readLegacyBlob(workspacePath);
      if (legacy) {
        // First read of a pre-split workspace: split the blob into the new
        // index + per-party files, keeping the blob as an untouched backup.
        this.migrateFromLegacy(workspacePath, legacy);
        return legacy;
      }
      return { ...initialState, parties: [], members: [], messages: [] };
    } catch (error) {
      log("error", "party", "failed to read party state", { workspacePath, error: errMsg(error) });
      return { ...initialState, parties: [], members: [], messages: [] };
    }
  }

  /** Writes the SHARED party index (list + advisory last-active hint). Rare. */
  writeIndex(workspacePath: string, parties: PartyDefinition[], lastActivePartyId?: string): void {
    this.writeJsonAtomic(this.indexPath(workspacePath), { version: 2, parties, lastActivePartyId });
  }

  /**
   * mtime (ms) of the shared index file, or -1 if absent. A cheap (single stat)
   * staleness probe for an in-memory compose cache: the index is rewritten on
   * every party create/select/remove (and on a legacy migration), so a changed
   * mtime signals another process altered the party LIST. Per-party detail edits
   * do NOT bump it — the cache owner invalidates explicitly on its own writes.
   */
  indexMtimeMs(workspacePath: string): number {
    try {
      return fs.statSync(this.indexPath(workspacePath)).mtimeMs;
    } catch {
      return -1;
    }
  }

  /** Writes ONE party's detail file (its members + messages). Isolated per party. */
  writeParty(workspacePath: string, partyId: string, members: PartyMember[], messages: PartyMessage[]): void {
    this.writeJsonAtomic(this.partyFilePath(workspacePath, partyId), { version: 2, members, messages: messages.slice(-200) });
  }

  /** The on-disk directory holding one party's members (role files, transcripts). */
  partyDir(workspacePath: string, partyId: string): string {
    return path.join(this.rootDir(workspacePath), "parties", sanitizeName(partyId));
  }

  memberDir(workspacePath: string, partyId: string, memberName: string): string {
    return path.join(this.partyDir(workspacePath, partyId), "members", sanitizeName(memberName));
  }

  /**
   * The workbench tab layout for one party, or undefined when none is stored.
   *
   * Beside the party rather than in a renderer's localStorage: every window on
   * this party must see the same tabs, and localStorage gave each window its own
   * copy of a shared key. Storing it with the workspace also means the layout
   * survives a reinstall and follows the workspace to another machine.
   *
   * Never throws — a missing or corrupt file reads as "nothing stored", which
   * the caller seeds from the member list.
   */
  readLayout(workspacePath: string, partyId: string): WorkbenchLayout | undefined {
    try {
      const raw = fs.readFileSync(this.layoutPath(workspacePath, partyId), "utf8");
      return sanitizeLayout(JSON.parse(raw)?.layout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", "party", "failed to read workbench layout", { partyId, error: errMsg(error) });
      }
      return undefined;
    }
  }

  writeLayout(workspacePath: string, partyId: string, layout: WorkbenchLayout): void {
    this.writeJsonAtomic(this.layoutPath(workspacePath, partyId), { version: 1, layout });
  }

  private layoutPath(workspacePath: string, partyId: string): string {
    return path.join(this.partyDir(workspacePath, partyId), "layout.json");
  }

  /**
   * The persisted transcript (assembled UI blocks) for one member. Trimmed to
   * the window described by {@link capTranscript}. Never throws — a missing or
   * corrupt file reads as an empty transcript.
   */
  readTranscript(workspacePath: string, partyId: string, memberName: string): unknown[] {
    try {
      const file = this.transcriptPath(workspacePath, partyId, memberName);
      // Read synchronously (not fs.promises): a lingering async read handle on
      // Windows makes a concurrent transcript SAVE fail its atomic rename with
      // EPERM. A sync read completes before returning, so read/save never race
      // on the same file. At ~700KB the parse is only a few ms, and the switch-
      // time render cost (bounded by the tail-first UI) is the real lever.
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.blocks) ? parsed.blocks : [];
    } catch (error) {
      // ENOENT (no transcript yet) is normal — restore reads as empty, not a warning.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", "party", "failed to read member transcript", { partyId, memberName, error: errMsg(error) });
      }
      return [];
    }
  }

  /**
   * Persists a member's transcript, either wholesale or as an append.
   *
   * With `afterId`, `blocks` replace everything stored after that block — the
   * caller ships only what changed instead of the entire transcript. The anchor
   * is resolved against {@link lastWritten}, a write-through mirror of the file,
   * so an append costs no read: this process is the only writer for its
   * workspace, and the head-trimming done by {@link capTranscript} means the
   * caller's indices do NOT match the file's — only ids can anchor safely.
   *
   * An anchor that is not found is NOT silently promoted to a full write: that
   * would persist a fragment as if it were the whole history. It reports
   * `applied: false` so the caller resends in full.
   */
  writeTranscript(workspacePath: string, partyId: string, memberName: string, save: TranscriptSave): TranscriptSaveResult {
    const incoming = Array.isArray(save.blocks) ? save.blocks : [];
    let next = incoming;
    if (save.afterId) {
      const stored = this.storedTranscript(workspacePath, partyId, memberName);
      const anchor = findLastBlockIndexById(stored, save.afterId);
      if (anchor < 0) {
        log("warn", "party", "transcript append could not be anchored; requesting a full save", {
          partyId, memberName, afterId: save.afterId, storedBlocks: stored.length,
        });
        return { applied: false, reason: "anchor-not-found" };
      }
      next = stored.slice(0, anchor + 1).concat(incoming);
    }
    const capped = capTranscript(next).map(stripAttachmentBytes).map((block) => this.externalizeBlockImages(workspacePath, block));
    this.writeJsonAtomic(this.transcriptPath(workspacePath, partyId, memberName), { version: 1, blocks: capped });
    this.lastWritten.set(this.transcriptKey(workspacePath, partyId, memberName), capped);
    return { applied: true };
  }

  /**
   * Moves a block's inline base64 images out to {@link imageDir} and leaves a
   * reference behind. Screenshots are the largest single things a transcript
   * holds and the one payload compression cannot shrink, so keeping them inline
   * costs both disk AND the renderer's parse of every block it never displays.
   *
   * A failed write is NOT allowed to drop the image silently: the block is kept
   * exactly as it was (bytes inline) and the failure is logged. A fat transcript
   * is a much smaller problem than a screenshot that vanished.
   */
  private externalizeBlockImages(workspacePath: string, block: unknown): unknown {
    try {
      return externalizeImages(block, (data, mediaType) => this.storeImage(workspacePath, data, mediaType));
    } catch (error) {
      log("error", "party", "transcript image externalization failed; keeping bytes inline", { error: errMsg(error) });
      return block;
    }
  }

  /** Writes image bytes under their own SHA-256, so a re-read costs nothing. */
  private storeImage(workspacePath: string, data: string, mediaType: string | undefined): StoredImageSource {
    const bytes = Buffer.from(data, "base64");
    const file = `${crypto.createHash("sha256").update(bytes).digest("hex")}.${extensionFor(mediaType)}`;
    const target = path.join(this.imageDir(workspacePath), file);
    // Content-addressed: identical bytes already on disk are the same file.
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    return { type: "agentparty-file", file, media_type: mediaType, bytes: bytes.byteLength };
  }

  /** Absolute path of an extracted image, or undefined if the name is not one. */
  imagePath(workspacePath: string, file: string): string | undefined {
    // `file` arrives from a transcript and, over HTTP, from a caller — resolve it
    // and require the result to stay inside the image dir so no `../` escapes.
    const dir = this.imageDir(workspacePath);
    const resolved = path.resolve(dir, file);
    return resolved.startsWith(path.resolve(dir) + path.sep) ? resolved : undefined;
  }

  private imageDir(workspacePath: string): string {
    return path.join(this.rootDir(workspacePath), TRANSCRIPT_IMAGE_DIR);
  }

  /** The current on-disk blocks, from the write-through mirror when warm. */
  private storedTranscript(workspacePath: string, partyId: string, memberName: string): unknown[] {
    const cached = this.lastWritten.get(this.transcriptKey(workspacePath, partyId, memberName));
    return cached ?? this.readTranscript(workspacePath, partyId, memberName);
  }

  private transcriptKey(workspacePath: string, partyId: string, memberName: string): string {
    return this.transcriptPath(workspacePath, partyId, memberName);
  }

  // ---- internals ---------------------------------------------------------

  private compose(workspacePath: string, index: PartyIndex): StoredPartyState {
    const members: PartyMember[] = [];
    const messages: PartyMessage[] = [];
    for (const party of index.parties) {
      const detail = this.readPartyFile(workspacePath, party.id);
      // The file's location IS the party — assign `partyId` authoritatively so
      // no downstream code ever has to guess (no `|| "default"` fallbacks).
      for (const member of detail.members) {
        members.push({ ...member, partyId: party.id });
      }
      for (const message of detail.messages) {
        messages.push({ ...message, partyId: party.id });
      }
    }
    return {
      version: 2,
      parties: index.parties,
      currentPartyId: index.lastActivePartyId,
      members,
      messages,
    };
  }

  private readIndexFile(workspacePath: string): PartyIndex | null {
    const file = this.indexPath(workspacePath);
    if (!fs.existsSync(file)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      parties: Array.isArray(parsed.parties) ? parsed.parties : [],
      lastActivePartyId: typeof parsed.lastActivePartyId === "string" ? parsed.lastActivePartyId : undefined,
    };
  }

  private readPartyFile(workspacePath: string, partyId: string): PartyDetail {
    try {
      const file = this.partyFilePath(workspacePath, partyId);
      if (!fs.existsSync(file)) {
        return { members: [], messages: [] };
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        members: Array.isArray(parsed.members) ? parsed.members : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch (error) {
      log("warn", "party", "failed to read party detail", { partyId, error: errMsg(error) });
      return { members: [], messages: [] };
    }
  }

  /**
   * Reads a legacy single-blob `state.json` (new root, then `.agentparty/`) and
   * NORMALIZES it so every party that owns members is present in `parties[]` and
   * every member/message has a `partyId` that names a real party. This one-time
   * healing of pre-split data is logged; it is the only place a party id is ever
   * derived rather than known, and it never runs on the live (post-split) path.
   */
  private readLegacyBlob(workspacePath: string): StoredPartyState | null {
    const candidates = [
      path.join(this.rootDir(workspacePath), "state.json"),
      path.join(workspacePath, LEGACY_ROOT, "state.json"),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const parties: PartyDefinition[] = Array.isArray(parsed.parties) ? parsed.parties : [];
      const rawMembers: PartyMember[] = Array.isArray(parsed.members) ? parsed.members : [];
      const rawMessages: PartyMessage[] = Array.isArray(parsed.messages) ? parsed.messages : [];
      // Pre-party legacy data (members but no parties) → synthesize a default party.
      if (parties.length === 0 && rawMembers.length > 0) {
        const now = new Date().toISOString();
        parties.push({ id: "default", name: "Default Party", createdAt: now, updatedAt: now });
        log("warn", "party", "legacy state had members but no party — synthesizing 'Default Party' during migration", { workspacePath, members: rawMembers.length });
      }
      const known = new Set(parties.map((party) => party.id));
      const fallbackPartyId = (known.has(parsed.currentPartyId) ? parsed.currentPartyId : undefined) || parties[0]?.id;
      const place = (ownPartyId: string | undefined): string => (ownPartyId && known.has(ownPartyId) ? ownPartyId : fallbackPartyId);
      return {
        version: 2,
        parties,
        currentPartyId: place(parsed.currentPartyId),
        members: rawMembers.map((m) => ({ ...m, partyId: place(m.partyId) })),
        messages: rawMessages.map((m) => ({ ...m, partyId: place(m.partyId) })),
      };
    }
    return null;
  }

  /** Splits a normalized legacy blob into the new index + per-party files (blob kept as backup). */
  private migrateFromLegacy(workspacePath: string, state: StoredPartyState): void {
    const detailByParty = new Map<string, PartyDetail>();
    for (const party of state.parties) {
      detailByParty.set(party.id, { members: [], messages: [] });
    }
    const detailFor = (partyId: string): PartyDetail => {
      const detail = detailByParty.get(partyId);
      if (!detail) {
        // Cannot happen: readLegacyBlob guaranteed every partyId names a party.
        throw new Error(`Migration invariant violated: record references unknown party '${partyId}'.`);
      }
      return detail;
    };
    for (const member of state.members) {
      detailFor(mustPartyId(member)).members.push(member);
    }
    for (const message of state.messages) {
      detailFor(mustPartyId(message)).messages.push(message);
    }
    this.writeIndex(workspacePath, state.parties, state.currentPartyId);
    for (const [partyId, detail] of detailByParty) {
      this.writeParty(workspacePath, partyId, detail.members, detail.messages);
    }
    log("info", "party", "migrated legacy state.json to per-party layout", { workspacePath, parties: state.parties.length, members: state.members.length });
  }

  private writeJsonAtomic(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Per-process temp name: two processes editing the same workspace (now a
    // supported multi-instance case) must never collide on one temp file, or
    // one's writeFile/rename would clobber the other's mid-flight. rename onto
    // the final path stays atomic. Mirrors settings.ts's writer.
    const tempPath = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tempPath, file);
  }

  private transcriptPath(workspacePath: string, partyId: string, memberName: string): string {
    return path.join(this.memberDir(workspacePath, partyId, memberName), "transcript.json");
  }

  private indexPath(workspacePath: string): string {
    return path.join(this.rootDir(workspacePath), "parties.json");
  }

  private partyFilePath(workspacePath: string, partyId: string): string {
    return path.join(this.partyDir(workspacePath, partyId), "party.json");
  }

  private rootDir(workspacePath: string): string {
    return path.join(workspacePath, ROOT_DIR);
  }
}

const ROOT_DIR = ".agent_party_app";
const LEGACY_ROOT = ".agentparty";
/** Max CONVERSATION blocks persisted per member. See {@link capTranscript}. */
const TRANSCRIPT_CAP = 800;
/** Absolute block ceiling, including status. See {@link capTranscript}. */
const TRANSCRIPT_HARD_CAP = 4000;

function isStatusBlock(block: unknown): boolean {
  return (block as { kind?: unknown } | null)?.kind === "status";
}

/**
 * Trims a transcript to its retention window, newest-first.
 *
 * The {@link TRANSCRIPT_CAP} budget counts conversation blocks only. `status`
 * blocks are progress chatter: 5% of the bytes but half of the blocks, so
 * charging them to the budget spent the window on chatter and evicted the
 * conversation instead. Measured transcripts sitting at the old cap held
 * 350-440 status blocks and, in three cases, zero user turns.
 *
 * Exempting them opens a hole — a member emitting only status never reaches
 * the budget and would grow without bound (one real transcript was 761 status
 * / 0 tool / 4 assistant). {@link TRANSCRIPT_HARD_CAP} closes it: unreachable
 * in normal use, and the only thing that bounds that shape.
 */
function capTranscript(blocks: unknown[]): unknown[] {
  let budget = TRANSCRIPT_CAP;
  let start = blocks.length;
  while (start > 0 && budget > 0) {
    start -= 1;
    if (!isStatusBlock(blocks[start])) {
      budget -= 1;
    }
  }
  return blocks.slice(Math.max(start, blocks.length - TRANSCRIPT_HARD_CAP));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loud invariant: a record placed into the per-party store MUST know its party. */
function mustPartyId(record: { partyId?: string; name?: string; id?: string }): string {
  if (!record.partyId) {
    throw new Error(`Party record '${record.name || record.id || "?"}' has no partyId — refusing to guess.`);
  }
  return record.partyId;
}

function sanitizeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Index of the transcript block with `id`, searched from the end. An append's
 * anchor is the caller's last persisted block, so it sits at or near the tail —
 * scanning backwards makes the common case O(1)-ish instead of O(n).
 */
function findLastBlockIndexById(blocks: unknown[], id: string): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if ((blocks[index] as { id?: unknown } | null)?.id === id) {
      return index;
    }
  }
  return -1;
}

/**
 * Drops image attachment bytes before a transcript is persisted. The base64
 * bytes are large and only needed for the live session's thumbnails; persisting
 * them would rewrite megabytes on every debounced save and bloat transcript.json.
 * The lightweight record (mediaType/name) is kept so the restored block still
 * knows an image was sent; the renderer only draws a thumbnail when bytes exist.
 */
function stripAttachmentBytes(block: unknown): unknown {
  const b = block as { attachments?: Array<{ dataBase64?: string }> } | null;
  if (!b || !Array.isArray(b.attachments) || b.attachments.length === 0) {
    return block;
  }
  return { ...b, attachments: b.attachments.map(({ dataBase64: _drop, ...rest }) => rest) };
}
