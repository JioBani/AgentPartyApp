/**
 * Splitting and reassembly for envelopes larger than one secure frame
 * (01 §5.6, fixed by develop 2026-08-15).
 *
 * Wire rule: the envelope's UTF-8 bytes are cut into pieces of at most
 * {@link CHUNK_RAW_BYTES}, and **each piece is base64url-encoded separately**
 * into `data`. Encoding the whole envelope first and slicing the base64 would
 * produce different bytes and would not interoperate — the split happens on the
 * raw bytes, which also keeps every piece a whole number of bytes regardless of
 * where a multi-byte character falls.
 *
 * A group's chunks must arrive contiguously and without another group
 * interleaved. Anything else (gap, reordering, `n` mismatch, duplicate,
 * oversize) ends the session, exactly as a frame gap does under 01 §4.2 — a
 * partially reassembled envelope cannot be recovered from, and there is no
 * timeout to hide behind.
 */

/** 01 §5.6 — raw-byte slice size, chosen so a chunk envelope stays under 64 KiB. */
export const CHUNK_RAW_BYTES = 32_768;

/** 01 §5.6 — refuse to reassemble beyond this, rather than growing unbounded. */
export const CHUNK_ASSEMBLY_MAX_BYTES = 16 * 1024 * 1024;

export interface ChunkEnvelope {
  k: "ctl";
  c: "chunk";
  /** Fresh uuid per group; unrelated to the enclosed envelope's `id`. */
  id: string;
  /** 0-based index. */
  i: number;
  /** Total chunk count. */
  n: number;
  /** base64url of this piece's raw bytes. */
  data: string;
}

export function needsChunking(serialized: string): boolean {
  return Buffer.byteLength(serialized, "utf8") > CHUNK_RAW_BYTES;
}

/**
 * Splits one serialized envelope into chunk envelopes.
 *
 * @param groupId fresh uuid identifying this group.
 */
export function splitEnvelope(serialized: string, groupId: string): ChunkEnvelope[] {
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > CHUNK_ASSEMBLY_MAX_BYTES) {
    throw new Error(
      `chunking: envelope of ${bytes.byteLength} bytes exceeds the ${CHUNK_ASSEMBLY_MAX_BYTES}-byte limit`,
    );
  }
  const total = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_RAW_BYTES));
  const chunks: ChunkEnvelope[] = [];
  for (let index = 0; index < total; index += 1) {
    const piece = bytes.subarray(index * CHUNK_RAW_BYTES, (index + 1) * CHUNK_RAW_BYTES);
    chunks.push({ k: "ctl", c: "chunk", id: groupId, i: index, n: total, data: piece.toString("base64url") });
  }
  return chunks;
}

/**
 * Reassembles one chunk group at a time. One instance per session.
 *
 * Every rejection throws: the caller ends the session. The alternative —
 * dropping a bad chunk and waiting — would leave the phone believing it sent a
 * request that the desktop will never answer.
 */
export class ChunkAssembler {
  private group: { id: string; total: number; next: number; pieces: Buffer[]; bytes: number } | undefined;

  /**
   * Accepts one chunk.
   *
   * @returns the reassembled envelope string once the group completes,
   *   otherwise `undefined`.
   * @throws on any inconsistency; the session must be closed.
   */
  accept(chunk: ChunkEnvelope): string | undefined {
    if (!Number.isInteger(chunk.n) || chunk.n < 1 || !Number.isInteger(chunk.i) || chunk.i < 0 || chunk.i >= chunk.n) {
      throw new Error(`chunking: chunk ${chunk.i}/${chunk.n} of group ${chunk.id} is out of range`);
    }
    if (this.group && this.group.id !== chunk.id) {
      throw new Error(`chunking: group ${chunk.id} interleaved with in-progress group ${this.group.id}`);
    }
    if (!this.group) {
      if (chunk.i !== 0) {
        throw new Error(`chunking: group ${chunk.id} started at index ${chunk.i} instead of 0`);
      }
      this.group = { id: chunk.id, total: chunk.n, next: 0, pieces: [], bytes: 0 };
    }
    if (this.group.total !== chunk.n) {
      throw new Error(`chunking: group ${chunk.id} changed its total from ${this.group.total} to ${chunk.n}`);
    }
    if (chunk.i !== this.group.next) {
      throw new Error(`chunking: group ${chunk.id} expected chunk ${this.group.next} but received ${chunk.i}`);
    }

    const piece = Buffer.from(chunk.data, "base64url");
    this.group.bytes += piece.byteLength;
    if (this.group.bytes > CHUNK_ASSEMBLY_MAX_BYTES) {
      const id = this.group.id;
      this.group = undefined;
      throw new Error(`chunking: group ${id} exceeded the ${CHUNK_ASSEMBLY_MAX_BYTES}-byte assembly limit`);
    }
    this.group.pieces.push(piece);
    this.group.next += 1;

    if (this.group.next < this.group.total) {
      return undefined;
    }
    const assembled = Buffer.concat(this.group.pieces).toString("utf8");
    this.group = undefined;
    return assembled;
  }

  /** True while a group is partially received — surfaced, never hidden. */
  get inProgress(): boolean {
    return this.group !== undefined;
  }

  reset(): void {
    this.group = undefined;
  }
}
