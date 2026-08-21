import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PartyDefinition, PartyMember, PartyMessage, TranscriptSave, TranscriptSaveResult } from "../shared/types";
import { capTranscript } from "../shared/transcriptCap";
import { externalizeImages, extensionFor, TRANSCRIPT_IMAGE_DIR, type StoredImageSource } from "../shared/transcriptImages";
import { sanitizeLayout, type WorkbenchLayout } from "../shared/workbenchLayout";
import { workspaceKey } from "../shared/workspaceLocation";
import { log } from "./logger";
import { ensureStorageDir, STORAGE_DIR } from "./workspaceStorage";

/**
 * The composed, in-memory party state — the shared party index PLUS every
 * party's own detail. It is assembled by {@link PartyRepository.read} from the
 * on-disk split layout (see below) and consumed exactly as before by the
 * service, so all `requireMember`/`view` logic is unchanged.
 *
 * On-disk layout under the repository root's `.agent_party_app/` (version 2).
 * On the desktop that root is the Windows-global party-store directory; a
 * former workspace root is used only by the explicit lazy importer:
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

export interface PartyStoreImportReport {
  source: string;
  target: string;
  found: number;
  imported: number;
  alreadyImported: number;
  backfilledLocations: number;
  conflicts: Array<{ partyId: string; reason: string }>;
  completed: boolean;
}

interface PartyStoreImportManifest {
  version: 1;
  sources: Record<string, {
    source: string;
    parties: Record<string, string>;
    completedAt?: string;
  }>;
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

  /** Whether a cwd contains party data worth offering to the global importer. */
  hasStore(workspacePath: string): boolean {
    return fs.existsSync(this.indexPath(workspacePath))
      || fs.existsSync(path.join(this.rootDir(workspacePath), "state.json"))
      || fs.existsSync(path.join(workspacePath, LEGACY_ROOT, "state.json"));
  }

  /**
   * Copies one legacy cwd-owned party store into the Windows-global store.
   *
   * The source is never removed or rewritten by this method. Party ids are the
   * merge key. A divergent duplicate is reported as a conflict instead of being
   * overwritten, while a byte-equivalent party left by an interrupted previous
   * run is recognized and adopted. The manifest is written after every party,
   * so a crash can resume without duplicating already copied data.
   */
  importWorkspace(
    sourceWorkspacePath: string,
    targetWorkspacePath: string,
    sourceIdentity: string,
    defaultMemberLocation: string,
  ): PartyStoreImportReport {
    const report: PartyStoreImportReport = {
      source: sourceIdentity,
      target: targetWorkspacePath,
      found: 0,
      imported: 0,
      alreadyImported: 0,
      backfilledLocations: 0,
      conflicts: [],
      completed: false,
    };
    if (!this.hasStore(sourceWorkspacePath)) {
      report.completed = true;
      return report;
    }

    const manifest = this.readImportManifest(targetWorkspacePath);
    const sourceKey = importSourceKey(sourceIdentity);
    const sourceRecord = manifest.sources[sourceKey] || {
      source: sourceIdentity,
      parties: {},
    };
    if (sourceRecord.completedAt) {
      const recorded = Object.keys(sourceRecord.parties).length;
      return { ...report, found: recorded, alreadyImported: recorded, completed: true };
    }

    const source = this.readForImport(sourceWorkspacePath);
    report.found = source.parties.length;
    const target = this.read(targetWorkspacePath);
    const targetParties = [...target.parties];
    const targetMembers = [...target.members];
    const targetMessages = [...target.messages];

    for (const party of source.parties) {
      const sourceMembers = source.members.filter((member) => member.partyId === party.id);
      const members = sourceMembers.map((member) => (
        member.location ? member : { ...member, location: defaultMemberLocation }
      ));
      const backfilledLocations = sourceMembers.filter((member) => !member.location).length;
      const messages = source.messages.filter((message) => message.partyId === party.id);
      const fingerprint = partyFingerprint(party, members, messages);
      if (sourceRecord.parties[party.id] === fingerprint) {
        report.alreadyImported += 1;
        continue;
      }

      const existing = targetParties.find((entry) => entry.id === party.id);
      if (existing) {
        const existingMembers = targetMembers.filter((member) => member.partyId === party.id);
        const existingMessages = targetMessages.filter((message) => message.partyId === party.id);
        if (partyFingerprint(existing, existingMembers, existingMessages) !== fingerprint) {
          report.conflicts.push({
            partyId: party.id,
            reason: `Global party '${party.id}' differs from the copy in '${sourceIdentity}'.`,
          });
          continue;
        }
        report.alreadyImported += 1;
      } else {
        this.copyPartySupplementalFiles(sourceWorkspacePath, targetWorkspacePath, party.id);
        this.writeParty(targetWorkspacePath, party.id, members, messages);
        targetParties.push(party);
        targetMembers.push(...members);
        targetMessages.push(...messages);
        this.writeIndex(
          targetWorkspacePath,
          targetParties,
          target.currentPartyId || source.currentPartyId || party.id,
        );
        report.imported += 1;
        report.backfilledLocations += backfilledLocations;
      }

      sourceRecord.parties[party.id] = fingerprint;
      manifest.sources[sourceKey] = sourceRecord;
      this.writeImportManifest(targetWorkspacePath, manifest);
    }

    // Both are shared across all parties in one legacy cwd. Merge them once
    // after the per-party loop, not once per party (large image stores made
    // the old shape quadratic in the number of parties). Successful parties
    // still keep their supplemental data when another id is in conflict.
    if (Object.keys(sourceRecord.parties).length > 0) {
      this.copyTranscriptImages(sourceWorkspacePath, targetWorkspacePath);
      this.mergeUsageLedger(sourceWorkspacePath, targetWorkspacePath, new Set(Object.keys(sourceRecord.parties)));
    }
    if (report.conflicts.length === 0) {
      sourceRecord.completedAt = new Date().toISOString();
      manifest.sources[sourceKey] = sourceRecord;
      this.writeImportManifest(targetWorkspacePath, manifest);
      report.completed = true;
    }
    log(report.completed ? "info" : "warn", "party", "legacy workspace party import finished", report);
    return report;
  }

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
    this.writeJsonAtomic(workspacePath, this.indexPath(workspacePath), { version: 2, parties, lastActivePartyId });
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
    this.writeJsonAtomic(workspacePath, this.partyFilePath(workspacePath, partyId), { version: 2, members, messages: messages.slice(-200) });
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
      const parsed = readJsonSurvivingWrite(this.layoutPath(workspacePath, partyId)) as { layout?: unknown } | undefined;
      return parsed === undefined ? undefined : sanitizeLayout(parsed.layout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", "party", "failed to read workbench layout", { partyId, error: errMsg(error) });
      }
      return undefined;
    }
  }

  writeLayout(workspacePath: string, partyId: string, layout: WorkbenchLayout): void {
    this.writeJsonAtomic(workspacePath, this.layoutPath(workspacePath, partyId), { version: 1, layout });
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
      const parsed = readJsonSurvivingWrite(file) as { blocks?: unknown } | undefined;
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
    this.writeJsonAtomic(workspacePath, this.transcriptPath(workspacePath, partyId, memberName), { version: 1, blocks: capped });
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

  /**
   * Writes image bytes under their own SHA-256, so a re-read costs nothing.
   *
   * Public because a member attaching an image to its own conversation stores it
   * the same way a tool screenshot is stored — the bytes must land here rather
   * than in the tool result, which is part of the model's conversation.
   */
  storeImage(workspacePath: string, data: string, mediaType: string | undefined): StoredImageSource {
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
    const parsed = readJsonSurvivingWrite(this.indexPath(workspacePath)) as PartyIndex | undefined;
    if (parsed === undefined) {
      return null;
    }
    return {
      parties: Array.isArray(parsed.parties) ? parsed.parties : [],
      lastActivePartyId: typeof parsed.lastActivePartyId === "string" ? parsed.lastActivePartyId : undefined,
    };
  }

  private readPartyFile(workspacePath: string, partyId: string): PartyDetail {
    try {
      const parsed = readJsonSurvivingWrite(this.partyFilePath(workspacePath, partyId)) as PartyDetail | undefined;
      if (parsed === undefined) {
        return { members: [], messages: [] };
      }
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

  private writeJsonAtomic(workspacePath: string, file: string, data: unknown): void {
    ensureStorageDir(this.rootDir(workspacePath));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Per-process temp name: two processes editing the same workspace (now a
    // supported multi-instance case) must never collide on one temp file, or
    // one's writeFile/rename would clobber the other's mid-flight. rename onto
    // the final path stays atomic. Mirrors settings.ts's writer.
    writeReplacing(file, `${JSON.stringify(data, null, 2)}\n`);
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

  /**
   * Reads a migration source without running any of the live store's repair or
   * split-on-read behavior. Migration must leave the former cwd byte-for-byte
   * intact so the Windows-global copy is reversible and independently auditable.
   * Unlike the live reader, this path rejects a missing/corrupt indexed detail
   * file instead of turning it into an empty party and recording a false success.
   */
  private readForImport(workspacePath: string): StoredPartyState {
    const index = this.readIndexFile(workspacePath);
    if (!index) {
      const legacy = this.readLegacyBlob(workspacePath);
      if (legacy) {
        return legacy;
      }
      throw new Error(`No party store exists in migration source '${workspacePath}'.`);
    }

    const members: PartyMember[] = [];
    const messages: PartyMessage[] = [];
    for (const party of index.parties) {
      const file = this.partyFilePath(workspacePath, party.id);
      const parsed = readJsonSurvivingWrite(file) as PartyDetail | undefined;
      if (!parsed) {
        throw new Error(`Party '${party.id}' is indexed but its detail file is missing: ${file}`);
      }
      if (!Array.isArray(parsed.members) || !Array.isArray(parsed.messages)) {
        throw new Error(`Party '${party.id}' has an invalid detail file: ${file}`);
      }
      members.push(...parsed.members.map((member) => ({ ...member, partyId: party.id })));
      messages.push(...parsed.messages.map((message) => ({ ...message, partyId: party.id })));
    }
    return {
      version: 2,
      parties: index.parties,
      currentPartyId: index.lastActivePartyId,
      members,
      messages,
    };
  }

  private importManifestPath(workspacePath: string): string {
    return path.join(this.rootDir(workspacePath), "workspace-imports.json");
  }

  private readImportManifest(workspacePath: string): PartyStoreImportManifest {
    try {
      const parsed = readJsonSurvivingWrite(this.importManifestPath(workspacePath)) as PartyStoreImportManifest | undefined;
      return parsed?.version === 1 && parsed.sources && typeof parsed.sources === "object"
        ? parsed
        : { version: 1, sources: {} };
    } catch (error) {
      throw new Error(`Global party migration record is unreadable: ${errMsg(error)}`);
    }
  }

  private writeImportManifest(workspacePath: string, manifest: PartyStoreImportManifest): void {
    this.writeJsonAtomic(workspacePath, this.importManifestPath(workspacePath), manifest);
  }

  /** Copies role files, layouts and transcripts; party.json is rewritten from normalized data. */
  private copyPartySupplementalFiles(sourceWorkspacePath: string, targetWorkspacePath: string, partyId: string): void {
    const source = this.partyDir(sourceWorkspacePath, partyId);
    if (!fs.existsSync(source)) {
      return;
    }
    const target = this.partyDir(targetWorkspacePath, partyId);
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (entry) => path.resolve(entry) !== path.resolve(this.partyFilePath(sourceWorkspacePath, partyId)),
    });
  }

  /** Transcript images are content-addressed, so merging without overwrite is deterministic. */
  private copyTranscriptImages(sourceWorkspacePath: string, targetWorkspacePath: string): void {
    const source = this.imageDir(sourceWorkspacePath);
    if (!fs.existsSync(source)) {
      return;
    }
    fs.mkdirSync(this.imageDir(targetWorkspacePath), { recursive: true });
    fs.cpSync(source, this.imageDir(targetWorkspacePath), { recursive: true, force: false, errorOnExist: false });
  }

  /**
   * Merges party-attributed usage records exactly once by their serialized
   * content. Records without a party id belong to standalone sessions, not the
   * party domain, and intentionally stay with their former execution context.
   */
  private mergeUsageLedger(sourceWorkspacePath: string, targetWorkspacePath: string, partyIds: Set<string>): void {
    const relative = path.join("usage", "turns.jsonl");
    const sourceFile = path.join(this.rootDir(sourceWorkspacePath), relative);
    if (!fs.existsSync(sourceFile) || partyIds.size === 0) {
      return;
    }
    const targetFile = path.join(this.rootDir(targetWorkspacePath), relative);
    const existing = fs.existsSync(targetFile)
      ? new Set(fs.readFileSync(targetFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean))
      : new Set<string>();
    const additions: string[] = [];
    for (const raw of fs.readFileSync(sourceFile, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      let record: { partyId?: unknown };
      try {
        record = JSON.parse(line) as { partyId?: unknown };
      } catch (error) {
        throw new Error(`Usage migration source has malformed JSONL: ${sourceFile}: ${errMsg(error)}`);
      }
      if (typeof record.partyId === "string" && partyIds.has(record.partyId) && !existing.has(line)) {
        additions.push(line);
        existing.add(line);
      }
    }
    if (additions.length > 0) {
      ensureStorageDir(this.rootDir(targetWorkspacePath));
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.appendFileSync(targetFile, `${additions.join("\n")}\n`, "utf8");
    }
  }

  private rootDir(workspacePath: string): string {
    return path.join(workspacePath, ROOT_DIR);
  }
}

const ROOT_DIR = STORAGE_DIR;
const LEGACY_ROOT = ".agentparty";

/**
 * Writes `contents` to `target`, surviving a Windows handle someone else holds.
 *
 * Normally this is the usual temp-then-rename, which is atomic. But Windows
 * refuses to rename ONTO a file another process has open, and Node reports that
 * as EPERM. It is not a permission problem and it is not the antivirus:
 * measured, 500 renames with nobody holding the file failed 0 times with
 * real-time protection on, while one reader handle failed 40 of 40, and
 * retrying never cleared it while the handle stayed open.
 *
 * ⚠️ Do NOT "fix" this by unlinking the target first. That was tried, and this
 * fix's own product e2e caught it destroying data: on Windows, deleting a file
 * someone holds open does not free the NAME, it marks it delete-pending, and
 * nothing can be created at a delete-pending name until the last handle closes.
 * The rename then failed too — leaving the member's transcript deleted and no
 * replacement in place.
 *
 * Writing THROUGH the existing file is what actually works (measured 40 of 40),
 * because a reader's handle does not deny writes. The cost is that this one
 * path is not atomic: a reader in another process could catch a half-written
 * file. {@link readJsonSurvivingWrite} is the other half of that trade.
 */
function writeReplacing(target: string, contents: string): void {
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
    // Visible on purpose: it names a real condition on the user's machine —
    // something else is holding our storage open — even though we recover.
    log("warn", "party", "another process holds this file open; writing in place instead", { target });
    fs.writeFileSync(target, contents);
  } finally {
    // A rename that threw leaves the temp behind. The next write reuses the
    // name, but a crash in between would strand a megabyte of JSON.
    if (fs.existsSync(temp)) {
      fs.rmSync(temp, { force: true });
    }
  }
}

/** Blocks briefly without a busy-loop. Only ever used to ride out a replace. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads a file that {@link replaceFile} may be swapping out from under us.
 *
 * During a replace the target is briefly absent. A reader landing in that gap
 * gets a file that is half old and half new, and `JSON.parse` rejects it. A
 * transcript that fails to parse reads as "this member never said anything",
 * so one unlucky read would blank a member's whole history.
 *
 * The writer's temp file is the tell, and it is exact: it exists only while a
 * write is in flight. Checking for it costs one readdir on the failure path
 * only, so a file that is genuinely absent or genuinely corrupt still answers
 * at once instead of sleeping through retries it can never satisfy.
 *
 * This is a CROSS-PROCESS guard. Writes here are synchronous, so no read in the
 * writing process can observe a partial write of its own; the reader at risk is
 * a second app instance on the same workspace.
 *
 * Returns undefined when the file is simply not there — a normal answer for a
 * member who has not spoken yet, or a party with no layout saved.
 */
function readJsonSurvivingWrite(file: string): unknown | undefined {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !writeInFlight(file)) {
        return undefined;
      }
      if (attempt >= WRITE_READ_RETRIES || !writeInFlight(file)) {
        throw error;
      }
      sleepMs(WRITE_READ_WAIT_MS);
    }
  }
}

/** True while some process is part-way through writing `file`. */
function writeInFlight(file: string): boolean {
  const prefix = `${path.basename(file)}.`;
  try {
    return fs.readdirSync(path.dirname(file)).some((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"));
  } catch {
    return false;
  }
}

/** A write is one syscall on a file of a few megabytes; this outlasts it. */
const WRITE_READ_RETRIES = 8;
const WRITE_READ_WAIT_MS = 15;

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

function importSourceKey(sourceIdentity: string): string {
  // Windows paths and WSL distro names are case-insensitive identities. The
  // opening window registry canonicalizes them, but an explicit HTTP retry may
  // use different casing; both must hit the same completed migration record.
  return crypto.createHash("sha256").update(workspaceKey(sourceIdentity)).digest("hex");
}

function partyFingerprint(party: PartyDefinition, members: PartyMember[], messages: PartyMessage[]): string {
  return crypto.createHash("sha256").update(JSON.stringify({ party, members, messages })).digest("hex");
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
