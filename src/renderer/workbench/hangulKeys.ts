/**
 * Reads Hangul back as the QWERTY keys that produced it.
 *
 * ## Why
 *
 * The composer triggers are Latin (`:a`, `:m`), but the IME is usually left on.
 * Typing `:a` with 한글 mode active produces `:ㅁ`, and nothing opens. That is not
 * a typo the user can see — the keys pressed were correct, and the app simply
 * refuses. Converting `ㅁ` back to `a` makes the trigger work under either IME
 * state, which is what the user actually means both times.
 *
 * The same applies to the filter text: `:ㅁ햐` is `:ahai` typed in 한글 mode.
 *
 * ## What this is not
 *
 * Not romanisation and not transliteration — `ㅁ` becomes `a` because they share
 * a KEY on the 두벌식 layout, not because they sound alike. A user whose member
 * really is named 한글 is unaffected: the caller keeps the original text too and
 * matches against both (see {@link queryVariants}).
 */

/** 두벌식 key for each standalone jamo. Doubles/compounds spell their key sequence. */
const JAMO_KEYS: Record<string, string> = {
  // 자음
  "ㄱ": "r", "ㄲ": "R", "ㄴ": "s", "ㄷ": "e", "ㄸ": "E", "ㄹ": "f", "ㅁ": "a",
  "ㅂ": "q", "ㅃ": "Q", "ㅅ": "t", "ㅆ": "T", "ㅇ": "d", "ㅈ": "w", "ㅉ": "W",
  "ㅊ": "c", "ㅋ": "z", "ㅌ": "x", "ㅍ": "v", "ㅎ": "g",
  // 겹받침 — two keys, in the order they are typed
  "ㄳ": "rt", "ㄵ": "sw", "ㄶ": "sg", "ㄺ": "fr", "ㄻ": "fa", "ㄼ": "fq",
  "ㄽ": "ft", "ㄾ": "fx", "ㄿ": "fv", "ㅀ": "fg", "ㅄ": "qt",
  // 모음
  "ㅏ": "k", "ㅐ": "o", "ㅑ": "i", "ㅒ": "O", "ㅓ": "j", "ㅔ": "p", "ㅕ": "u",
  "ㅖ": "P", "ㅗ": "h", "ㅛ": "y", "ㅜ": "n", "ㅠ": "b", "ㅡ": "m", "ㅣ": "l",
  // 겹모음 — also two keys
  "ㅘ": "hk", "ㅙ": "ho", "ㅚ": "hl", "ㅝ": "nj", "ㅞ": "np", "ㅟ": "nl", "ㅢ": "ml",
};

/** Jamo in the order the syllable block encodes them. */
const LEAD = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const VOWEL = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/* 28 finals, index 0 = none. An ARRAY with an empty first slot rather than a
   string with a leading space: the sentinel would be an invisible character in
   the source, which git reads as binary and any whitespace-normalising tool
   would quietly delete, taking the whole final-consonant mapping with it. */
const TAIL = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

const SYLLABLE_START = 0xac00;
const SYLLABLE_END = 0xd7a3;

/**
 * The QWERTY keys that would produce `text`.
 *
 * Composed syllables (`햐`) are taken apart into their jamo first; standalone
 * jamo (`ㅁ`, what you get before a syllable completes) map straight across.
 * Anything that is not Hangul is passed through untouched, so a mixed string
 * survives intact.
 */
export function qwertyFromHangul(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= SYLLABLE_START && code <= SYLLABLE_END) {
      const index = code - SYLLABLE_START;
      const lead = LEAD[Math.floor(index / 588)];
      const vowel = VOWEL[Math.floor((index % 588) / 28)];
      const tail = TAIL[index % 28];
      out += (JAMO_KEYS[lead] || "") + (JAMO_KEYS[vowel] || "") + (tail ? JAMO_KEYS[tail] || "" : "");
      continue;
    }
    out += JAMO_KEYS[char] ?? char;
  }
  return out;
}

/** True when the string holds any Hangul — syllable or standalone jamo. */
export function hasHangul(text: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힣]/.test(text);
}

/**
 * The spellings a query should be matched against: what was typed, and — when it
 * contains Hangul — the Latin keys behind it.
 *
 * BOTH are kept on purpose. Converting unconditionally would break a member
 * genuinely named in Korean (`지오` would be searched for as `wldh`), so the
 * original always goes first and the conversion is only a fallback.
 */
export function queryVariants(query: string): string[] {
  if (!query || !hasHangul(query)) {
    return [query];
  }
  const latin = qwertyFromHangul(query);
  return latin && latin !== query ? [query, latin] : [query];
}
