/**
 * Member mention candidates for the composer's triggerless completion.
 *
 * Separate from the `/` command palette on purpose. That one triggers only when
 * the WHOLE draft is the command (it bails on any whitespace) and replaces the
 * entire draft on select, because a slash command is the message. A mention
 * happens mid-sentence, so it has to work from the caret and replace only the
 * token under it — different rules, different code, and `/` keeps behaving
 * exactly as it does today.
 *
 * Typing the beginning of a member name opens the list. A selected mention still
 * looks like `@alice` and serializes to `@alice`, so sent messages and the
 * transcript tokenizer are untouched.
 */
import { rankByFuzzyAny } from "./fuzzyMatch";

/** A member offered for completion. */
export interface MentionCandidate {
  name: string;
  /** Member identity colour — the row's dot and name. */
  color: string;
  /** Short status shown on the right (`working` / `승인 대기` / `idle` / …). */
  status: string;
}

/** Most candidates shown at once; beyond this the list becomes a scan, not a pick. */
export const MENTION_LIMIT = 6;

/** Addresses the whole party at once. */
export const EVERYONE = "everyone";

/**
 * The `@everyone` row.
 *
 * Like every other mention this writes text — it says "all of you" inside the
 * message rather than triggering a broadcast, which is a different action with
 * its own control. The subtitle says so, so the row cannot be mistaken for one.
 */
export const EVERYONE_CANDIDATE: MentionCandidate = {
  name: EVERYONE,
  color: "var(--text-1)",
  status: "파티 전원",
};

/** Tooltip for a mention chip — `everyone` is a group, not a member. */
export function mentionTitle(name: string): string {
  return name === EVERYONE ? "파티 전원을 멘션" : `${name} 멤버를 멘션`;
}

/*
 * Detection lives in `completionModel.ts`.
 *
 * Members and models are recognised by the same word detector, so there is one
 * place for the "must start a word" and reserved-punctuation rules to live.
 */

/**
 * Members offered for the current word, in party order.
 *
 * `exclude` is the member whose conversation this is: mentioning the person you
 * are already talking to is noise. Only real party members ever appear —
 * completing a name that does not exist would produce a message addressed to
 * nobody, which fails silently at the other end.
 *
 * `queries` is the typed text in every spelling worth trying (as typed, and the
 * Latin keys behind it when the IME was on). Matching is the same subsequence
 * ranking the model list uses — one search behaviour across both lists, so a
 * query that finds a model the way you expect finds a member the same way.
 */
export function mentionCandidates(
  members: readonly MentionCandidate[],
  exclude: string,
  queries: readonly string[],
): MentionCandidate[] {
  const pool = members.filter((member) => member.name !== exclude);
  // `@everyone` leads: with several members it is usually what you mean when
  // addressing the group, and it needs no scanning to find. It is only offered
  // when there IS a group — with one other member it would just be their name
  // spelled differently.
  const offered = members.length > 1 ? [EVERYONE_CANDIDATE, ...pool] : pool;
  const empty = queries.every((query) => !query.trim());
  const ranked = empty ? offered : rankByFuzzyAny(offered, queries, (candidate) => candidate.name);
  return ranked.slice(0, MENTION_LIMIT);
}

/*
 * Insertion is not here.
 *
 * A plain-string version of "replace the trigger with the name" used to live
 * alongside this, but the composer is a contenteditable: it has to replace a
 * RANGE with a chip element, not splice a string. Keeping a string version that
 * nothing called was a second answer to a question with one caller — see
 * `Composer.tsx` `applyCompletionChoice`.
 */
