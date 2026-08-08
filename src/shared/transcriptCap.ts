/**
 * How much of a member's transcript is kept on disk.
 *
 * Shared because the MAIN process enforces the window at persist time and the
 * RENDERER has to recognise a transcript that is sitting at it — that is the
 * point where older history was dropped and the harness original is the only
 * remaining copy.
 */

/** Max CONVERSATION blocks persisted per member. See {@link capTranscript}. */
export const TRANSCRIPT_CAP = 800;

/** Absolute block ceiling, including status. See {@link capTranscript}. */
export const TRANSCRIPT_HARD_CAP = 4000;

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
export function capTranscript<T>(blocks: T[]): T[] {
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

/**
 * True when a transcript is full, i.e. the next save drops its oldest blocks.
 *
 * Used to tell the user that what they can scroll back to is not everything —
 * without it, reaching the top looks identical to having reached the beginning
 * of the conversation.
 */
export function isTranscriptAtCap(blocks: unknown[]): boolean {
  const conversation = blocks.reduce<number>((n, block) => (isStatusBlock(block) ? n : n + 1), 0);
  return conversation >= TRANSCRIPT_CAP || blocks.length >= TRANSCRIPT_HARD_CAP;
}
