import * as fs from "node:fs";
import * as path from "node:path";
import type { PartyDefinition, PartyMember, PartyMessage } from "../shared/types";
import { log } from "./logger";

export interface StoredPartyState {
  version: 1;
  parties: PartyDefinition[];
  currentPartyId?: string;
  members: PartyMember[];
  messages: PartyMessage[];
}

const initialState: StoredPartyState = { version: 1, parties: [], members: [], messages: [] };

export class PartyRepository {
  read(workspacePath: string): StoredPartyState {
    const filePath = this.resolveReadPath(workspacePath);
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ...initialState, parties: [], members: [], messages: [] };
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const parties = Array.isArray(parsed.parties) ? parsed.parties : [];
      const legacyPartyId = parsed.currentPartyId || parties[0]?.id || "default";
      return {
        version: 1,
        parties,
        currentPartyId: parsed.currentPartyId || parties[0]?.id,
        members: Array.isArray(parsed.members)
          ? parsed.members.map((member: PartyMember) => ({ ...member, partyId: member.partyId || legacyPartyId }))
          : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch (error) {
      log("error", "party", "failed to read party state", { filePath, error: error instanceof Error ? error.message : String(error) });
      return { ...initialState, parties: [], members: [], messages: [] };
    }
  }

  write(workspacePath: string, state: StoredPartyState): void {
    const filePath = this.filePath(workspacePath);
    const tempPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify({
      version: 1,
      parties: state.parties,
      currentPartyId: state.currentPartyId,
      members: state.members,
      messages: state.messages.slice(-200),
    }, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  }

  memberDir(workspacePath: string, partyId: string, memberName: string): string {
    return path.join(this.rootDir(workspacePath), "parties", sanitizeName(partyId), "members", sanitizeName(memberName));
  }

  /**
   * The persisted transcript (assembled UI blocks) for one member, so a closed
   * member or a reopened app restores its conversation. Capped to the most recent
   * {@link TRANSCRIPT_CAP} blocks to bound the file. Never throws — a missing or
   * corrupt file reads as an empty transcript.
   */
  readTranscript(workspacePath: string, partyId: string, memberName: string): unknown[] {
    try {
      const file = this.transcriptPath(workspacePath, partyId, memberName);
      if (!fs.existsSync(file)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed?.blocks) ? parsed.blocks : [];
    } catch (error) {
      log("warn", "party", "failed to read member transcript", { partyId, memberName, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  writeTranscript(workspacePath: string, partyId: string, memberName: string, blocks: unknown[]): void {
    const file = this.transcriptPath(workspacePath, partyId, memberName);
    const capped = Array.isArray(blocks) ? blocks.slice(-TRANSCRIPT_CAP) : [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempPath = `${file}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, blocks: capped }, null, 2)}\n`);
    fs.renameSync(tempPath, file);
  }

  private transcriptPath(workspacePath: string, partyId: string, memberName: string): string {
    return path.join(this.memberDir(workspacePath, partyId, memberName), "transcript.json");
  }

  private filePath(workspacePath: string): string {
    return path.join(this.rootDir(workspacePath), "state.json");
  }

  /** Prefers the new root; falls back to legacy `.agentparty/state.json` once. */
  private resolveReadPath(workspacePath: string): string {
    const current = this.filePath(workspacePath);
    if (fs.existsSync(current)) {
      return current;
    }
    const legacy = path.join(workspacePath, LEGACY_ROOT, "state.json");
    return fs.existsSync(legacy) ? legacy : current;
  }

  private rootDir(workspacePath: string): string {
    return path.join(workspacePath, ROOT_DIR);
  }
}

const ROOT_DIR = ".agent_party_app";
const LEGACY_ROOT = ".agentparty";
/** Max transcript blocks persisted per member (bounds the on-disk file). */
const TRANSCRIPT_CAP = 800;

function sanitizeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
}
