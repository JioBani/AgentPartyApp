/**
 * Idle sleep — releasing a quiet member's harness process while keeping its
 * conversation.
 *
 * A party keeps one harness process per member for as long as the member exists,
 * and each of those holds real memory whether or not anyone is talking to it. A
 * workspace with a dozen members pays for a dozen processes to sit still. Sleep
 * gives that memory back: the process is released, `PartyMember.harnessSessionId`
 * keeps the conversation, and the next message resumes it.
 *
 * The timeout is a floor on how long a member must be quiet, never the only
 * condition — see the refusals in SessionManager's idle scan (a turn in flight,
 * an approval waiting, a compaction, detached background work, a queued
 * message). This module only owns the settings and their bounds.
 */

export interface IdleSleepSettings {
  /** Whether quiet members are released at all. */
  enabled: boolean;
  /** How long a member must be quiet first. */
  timeoutMinutes: number;
}

export const DEFAULT_IDLE_SLEEP: IdleSleepSettings = { enabled: true, timeoutMinutes: 5 };

/**
 * Under a minute the wake-up cost starts to dominate — a member would be torn
 * down and rebuilt between two halves of one thought. A day is the far end: past
 * that the setting is effectively "off", which `enabled: false` already says.
 */
export const IDLE_SLEEP_MIN_MINUTES = 1;
export const IDLE_SLEEP_MAX_MINUTES = 24 * 60;

/** Clamps an arbitrary stored/HTTP value to a usable setting. */
export function sanitizeIdleSleep(value: unknown): IdleSleepSettings {
  const record = value && typeof value === "object" ? (value as Partial<IdleSleepSettings>) : {};
  const minutes = Number(record.timeoutMinutes);
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_IDLE_SLEEP.enabled,
    timeoutMinutes: Number.isFinite(minutes)
      ? Math.min(IDLE_SLEEP_MAX_MINUTES, Math.max(IDLE_SLEEP_MIN_MINUTES, minutes))
      : DEFAULT_IDLE_SLEEP.timeoutMinutes,
  };
}

/** The quiet period in milliseconds, for comparing against a session's last activity. */
export function idleSleepTimeoutMs(settings: IdleSleepSettings): number {
  return sanitizeIdleSleep(settings).timeoutMinutes * 60_000;
}
