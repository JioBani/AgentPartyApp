/** A brief event-loop yield between transcript reads and DOM mount chunks. */
export const PROGRESSIVE_TRANSCRIPT_GAP_MS = 32;

const AUTO_MOUNT_BLOCKS = 40;

/** One progressive step toward the established transcript history window. */
export function nextTranscriptMountLimit(current: number, target: number): number {
  return Math.min(target, current + AUTO_MOUNT_BLOCKS);
}
