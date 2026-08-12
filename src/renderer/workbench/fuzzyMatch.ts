/**
 * Subsequence ("fuzzy") matching for the composer's completion lists.
 *
 * ## Why one module
 *
 * The `//` model chain (F-14) and the `/` command palette (F-05) are two lists
 * over the same kind of problem — dozens of items, one of which the user means.
 * If each grew its own matcher the two would develop a different *feel*: a query
 * that finds a model would fail on a command for no reason the user can see.
 * Both call this.
 *
 * ## What is searched: exactly what is on screen
 *
 * The haystack is the row's RENDERED text, never a hidden id. A user who cannot
 * see why a row matched cannot predict the next query, so `Haiku 4.5` is found
 * by "haiku" and by "4.5" — and by "anthropic" only if the provider is printed
 * on the row. Callers pass the visible strings; see {@link rowHaystack}.
 *
 * ## Separators do not count
 *
 * Both sides are reduced to letters and digits before matching, so `claude-code`
 * finds `Claude Code` and `gpt5` finds `GPT-5.4`. Without this, the punctuation
 * a user did or did not type would decide whether the row appears, which is not
 * something they should have to think about. Indices are mapped back to the
 * original string so the caller can still highlight the right characters.
 */

export interface FuzzyResult {
  /** Higher is a better match. Only meaningful when comparing the same query. */
  score: number;
  /** Indices into the ORIGINAL haystack that matched, for highlighting. */
  indices: number[];
}

/**
 * Lowercased letters, digits and Hangul, plus a map back to original indices.
 *
 * Hangul is kept rather than stripped because member names are often Korean:
 * dropping it made every Korean query normalize to the empty string, which the
 * matcher then read as "no filter" and returned the entire list. A Korean name
 * has to be findable by typing it.
 */
function normalize(text: string): { chars: string; map: number[] } {
  let chars = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase();
    const code = ch.codePointAt(0) ?? 0;
    const alnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    // Syllables (가-힣) and the standalone jamo an unfinished syllable leaves.
    const hangul = (code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3131 && code <= 0x318e);
    if (alnum || hangul) {
      chars += ch;
      map.push(i);
    }
  }
  return { chars, map };
}

/**
 * Positions in the normalized haystack that begin a "word" — the start, or the
 * first alphanumeric after punctuation/space, or a lower→upper camel boundary.
 * Matching there is what makes `cc` find `Claude Code` ahead of `codex-cli`.
 */
function wordStarts(text: string, map: number[]): Set<number> {
  const starts = new Set<number>();
  for (let n = 0; n < map.length; n++) {
    const i = map[n];
    if (n === 0 || map[n - 1] !== i - 1) {
      starts.add(n);
      continue;
    }
    const previous = text[i - 1];
    const current = text[i];
    if (previous >= "a" && previous <= "z" && current >= "A" && current <= "Z") {
      starts.add(n);
    }
  }
  return starts;
}

/**
 * Scores `text` against `query`, or returns null when the query's characters do
 * not appear in order.
 *
 * An empty query matches everything with score 0, so an unfiltered list keeps
 * its natural order instead of being ranked arbitrarily.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const needle = normalize(query);
  if (!needle.chars) {
    // A query that had characters but normalizes away (punctuation only) is a
    // real filter that matches nothing — reporting "matches everything" there
    // silently un-filters the list, which reads as the feature being broken.
    return query.trim() ? null : { score: 0, indices: [] };
  }
  const hay = normalize(text);
  if (!hay.chars) {
    return null;
  }

  // A contiguous run is what the user most often means, so it is found first and
  // scored above any scattered match. Ranked by how early it starts and how
  // little of the row is left over, which puts `Opus 5` above `Opus 5 (1M)`.
  const direct = hay.chars.indexOf(needle.chars);
  if (direct >= 0) {
    const starts = wordStarts(text, hay.map);
    const bonus = starts.has(direct) ? 400 : 0;
    const score = 2000 + bonus - direct * 4 - (hay.chars.length - needle.chars.length);
    return { score, indices: hay.map.slice(direct, direct + needle.chars.length) };
  }

  // Otherwise walk the query greedily. Greedy is not optimal, but it is
  // predictable — the same query always highlights the same characters, which
  // matters more here than squeezing out a better-looking match.
  const starts = wordStarts(text, hay.map);
  const picked: number[] = [];
  let at = 0;
  for (const ch of needle.chars) {
    const found = hay.chars.indexOf(ch, at);
    if (found < 0) {
      return null;
    }
    picked.push(found);
    at = found + 1;
  }

  let score = 1000 - picked[0] * 4 - (hay.chars.length - needle.chars.length);
  for (let i = 0; i < picked.length; i++) {
    if (starts.has(picked[i])) {
      score += 60;
    }
    if (i > 0 && picked[i] === picked[i - 1] + 1) {
      score += 40;
    }
  }
  return { score, indices: picked.map((n) => hay.map[n]) };
}

/**
 * The searchable text of a row: everything the row displays, in the order it is
 * displayed. Keeping this in one function is what keeps the promise that what
 * is visible is what is searchable — a caller that renders a new field adds it
 * here and the two cannot drift apart.
 */
export function rowHaystack(parts: readonly (string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Ranks by the first spelling of the query that matches anything.
 *
 * The spellings are the same text under different keyboard states — what was
 * typed, and the Latin keys behind it when the IME was on (see
 * `hangulKeys.ts`). Trying them in order rather than merging keeps the result
 * predictable: a member genuinely named in Korean is found by the text as typed,
 * and only a query that finds NOTHING that way is retried as Latin.
 */
export function rankByFuzzyAny<T>(rows: readonly T[], queries: readonly string[], haystackOf: (row: T) => string): T[] {
  for (const query of queries) {
    const hits = rankByFuzzy(rows, query, haystackOf);
    if (hits.length) {
      return hits;
    }
  }
  return [];
}

/**
 * Filters and ranks rows by a query, keeping the input order for ties so an
 * empty or weakly-discriminating query does not shuffle the list.
 */
export function rankByFuzzy<T>(rows: readonly T[], query: string, haystackOf: (row: T) => string): T[] {
  const scored: { row: T; score: number; index: number }[] = [];
  rows.forEach((row, index) => {
    const hit = fuzzyMatch(query, haystackOf(row));
    if (hit) {
      scored.push({ row, score: hit.score, index });
    }
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map((entry) => entry.row);
}
