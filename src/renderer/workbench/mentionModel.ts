/**
 * `@` member mention in the composer.
 *
 * Separate from the `/` command palette on purpose. That one triggers only when
 * the WHOLE draft is the command (it bails on any whitespace) and replaces the
 * entire draft on select, because a slash command is the message. A mention
 * happens mid-sentence, so it has to work from the caret and replace only the
 * token under it — different rules, different code, and `/` keeps behaving
 * exactly as it does today.
 */

/** A member offered for completion. */
export interface MentionCandidate {
  name: string;
  /** Member identity colour — the row's dot and name. */
  color: string;
  /** Short status shown on the right (`working` / `승인 대기` / `idle` / …). */
  status: string;
}

export interface MentionTrigger {
  /** Text typed after `@`, used to filter. */
  query: string;
  /** Index of the `@` in the draft. */
  start: number;
  /** Index just past the query (the caret). */
  end: number;
}

/** Most candidates shown at once; beyond this the list becomes a scan, not a pick. */
export const MENTION_LIMIT = 6;

/**
 * Finds an active mention immediately before the caret.
 *
 * `@` must start a word — otherwise an email address or a path would open the
 * popover mid-typing. The query stops at whitespace and at a second `@`.
 */
export function detectMention(draft: string, caret: number): MentionTrigger | null {
  const upToCaret = draft.slice(0, Math.max(0, caret));
  const match = /(^|[\s(\[{"'])@([^\s@]*)$/.exec(upToCaret);
  if (!match) {
    return null;
  }
  const query = match[2];
  return { query, start: upToCaret.length - query.length - 1, end: upToCaret.length };
}

/**
 * Members offered for `@`, in party order.
 *
 * `exclude` is the member whose conversation this is: mentioning the person you
 * are already talking to is noise. Only real party members ever appear —
 * completing a name that does not exist would produce a message addressed to
 * nobody, which fails silently at the other end.
 */
export function mentionCandidates(members: readonly MentionCandidate[], exclude: string, query: string): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  return members
    .filter((member) => member.name !== exclude)
    .filter((member) => (needle ? member.name.toLowerCase().includes(needle) : true))
    .slice(0, MENTION_LIMIT);
}

/**
 * Replaces the `@query` under the caret with the chosen member.
 *
 * A trailing space closes the trigger, so the popover does not reopen on the
 * name that was just accepted, and the user can keep typing straight away.
 */
export function applyMention(draft: string, trigger: MentionTrigger, name: string): { draft: string; caret: number } {
  const inserted = `@${name} `;
  const next = draft.slice(0, trigger.start) + inserted + draft.slice(trigger.end);
  return { draft: next, caret: trigger.start + inserted.length };
}
