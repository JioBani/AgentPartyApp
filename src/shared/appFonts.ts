/**
 * App font selection — what a stored/HTTP font value means and how it becomes a
 * CSS stack.
 *
 * The selection is a **family name as the OS reports it** (`"Malgun Gothic"`),
 * not an id from a list this file controls: the picker enumerates the fonts
 * actually installed (`queryLocalFonts`, see renderer/app/fontProbe.ts), so the
 * set of legal values is the machine's, not ours. Empty string means "the
 * platform default stack".
 *
 * What stays here is everything that must agree across main (persistence),
 * renderer (it writes the stacks into `--font-sans` / `--font-mono`) and the
 * picker: the fallback tails, the sanitiser, the legacy-id migration, and a
 * short RECOMMENDED list the picker floats to the top. Pure data + pure
 * functions — no I/O, no DOM — so the main process can use it too.
 */

export type FontRole = "sans" | "mono";

/** Tail every sans stack ends with, so a family that vanishes still renders. */
export const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Same for code and tool output. */
export const MONO_FALLBACK = 'ui-monospace, "SF Mono", Consolas, monospace';

/** The one family shipped inside the app (design-system.css `@font-face`). */
export const BUNDLED_FAMILY = "Maplestory";

export interface FontSettings {
  /** UI text (`--font-sans`). Family name, or "" for the platform default. */
  sans: string;
  /** Code, tool output and every `.wb-mono` label (`--font-mono`). */
  mono: string;
}

/**
 * Built-in defaults — the exact families design-system.css hard-coded before
 * this setting existed, so a user who never opens the picker sees no change.
 */
export const DEFAULT_FONT_SETTINGS: FontSettings = { sans: BUNDLED_FAMILY, mono: "Geist Mono" };

export interface RecommendedFont {
  family: string;
  label: string;
  role: FontRole;
  note: string;
  /** Shipped with the app — present even on a machine that has nothing else. */
  bundled?: boolean;
}

/**
 * Fonts the picker floats above the enumerated list.
 *
 * Advisory only — every one of these is just a family name that either is or is
 * not installed, exactly like the hundreds below it. The list exists because an
 * alphabetical dump of ~300 system families buries the handful that are
 * actually good choices for a Korean UI, and because the app must still offer
 * something sensible when enumeration is unavailable.
 */
export const RECOMMENDED_FONTS: RecommendedFont[] = [
  { family: BUNDLED_FAMILY, label: "Maplestory", role: "sans", note: "앱에 포함됨 · 넥슨 메이플스토리체", bundled: true },
  { family: "Pretendard", label: "Pretendard", role: "sans", note: "본문 가독성이 좋은 한글 폰트" },
  { family: "Noto Sans KR", label: "Noto Sans KR", role: "sans", note: "구글 본고딕" },
  { family: "Malgun Gothic", label: "맑은 고딕", role: "sans", note: "Windows 기본 한글 폰트" },
  { family: "NanumGothic", label: "나눔고딕", role: "sans", note: "네이버 나눔고딕" },
  { family: "Geist Mono", label: "Geist Mono", role: "mono", note: "기본값 · 없으면 시스템 고정폭으로 표시" },
  { family: "D2Coding", label: "D2Coding", role: "mono", note: "한글 폭이 정확한 코딩 폰트" },
  { family: "Cascadia Mono", label: "Cascadia Mono", role: "mono", note: "Windows Terminal · VS Code 와 함께 설치됨" },
  { family: "Consolas", label: "Consolas", role: "mono", note: "Windows 기본 고정폭 폰트" },
  { family: "JetBrains Mono", label: "JetBrains Mono", role: "mono", note: "JetBrains IDE 계열 폰트" },
];

export function recommendedFor(role: FontRole): RecommendedFont[] {
  return RECOMMENDED_FONTS.filter((font) => font.role === role);
}

/**
 * One installed family as the renderer's enumeration reports it.
 *
 * `monospace` is MEASURED, not read off the name — a family called "…Mono" is
 * not necessarily fixed-width, and several that are (DotumChe, GulimChe) say
 * nothing of the sort. Hangul coverage is deliberately NOT a field here; see the
 * note in renderer/app/fontProbe.ts for why it cannot be decided from the DOM.
 *
 * Declared here, not in the renderer module that produces it, so the main
 * process can type the value it relays over HTTP without importing renderer
 * code (which would point the dependency the wrong way and drag in DOM types).
 */
export interface LocalFontFamily {
  family: string;
  monospace: boolean;
}

export interface LocalFontListing {
  families: LocalFontFamily[];
  /** Why the list is empty or incomplete. Absent on a clean enumeration. */
  error?: string;
}

/**
 * Ids the first version of this setting persisted, before the picker
 * enumerated real fonts. Migrated on read so an upgrading user keeps the font
 * they chose instead of silently reverting to the default.
 */
const LEGACY_ID_FAMILIES: Record<string, string> = {
  maplestory: BUNDLED_FAMILY,
  pretendard: "Pretendard",
  "noto-sans-kr": "Noto Sans KR",
  "malgun-gothic": "Malgun Gothic",
  "nanum-gothic": "NanumGothic",
  "system-sans": "",
  "geist-mono": "Geist Mono",
  d2coding: "D2Coding",
  "cascadia-mono": "Cascadia Mono",
  consolas: "Consolas",
  "jetbrains-mono": "JetBrains Mono",
  "system-mono": "",
};

/**
 * Romanised tokens that appear in Korean font names, and the Hangul a Korean
 * user would actually type to look for them.
 *
 * `queryLocalFonts()` reports the PRIMARY family name, which for every Korean
 * font on Windows is romanised — "Malgun Gothic", "GulimChe", "NanumBarunGothic".
 * So a user of a Korean UI searching "고딕" finds nothing, which is the one
 * search a Korean user is most likely to try.
 *
 * Tokens rather than a family→alias table on purpose: a table would have to list
 * every 나눔 variant a machine might have installed (there are dozens), while
 * "nanum"→"나눔" covers all of them and any future one.
 */
const ROMANIZED_TOKENS: Array<[RegExp, string]> = [
  [/malgun/i, "맑은"],
  [/gothic/i, "고딕"],
  [/gulim/i, "굴림"],
  [/dotum/i, "돋움"],
  [/batang/i, "바탕"],
  [/gungsuh/i, "궁서"],
  [/nanum/i, "나눔"],
  [/myeongjo/i, "명조"],
  [/barun/i, "바른"],
  [/square/i, "스퀘어"],
  [/round/i, "라운드"],
  [/pretendard/i, "프리텐다드"],
  [/noto/i, "노토"],
  // Only Korean faces use the "…Che" suffix (굴림체, 바탕체 — the fixed-width cuts).
  [/che$/i, "체"],
];

/** The text a search query is matched against: the name plus its Hangul reading. */
export function fontSearchText(family: string, label?: string): string {
  const hangul = ROMANIZED_TOKENS.filter(([pattern]) => pattern.test(family)).map(([, text]) => text);
  return [family, label || "", ...hangul].join(" ").toLowerCase();
}

/**
 * Case-insensitive substring match over the family name, its display label and
 * its Hangul reading — so "malgun", "Malgun Gothic", "맑은" and "고딕" all find
 * 맑은 고딕. Shared by the picker's search box and `GET /api/appearance/fonts?q=`
 * so the two can never return different results for the same query.
 */
export function matchesFontQuery(family: string, query: string, label?: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || fontSearchText(family, label).includes(q);
}

/** Longest family name accepted. Real families are far shorter. */
const MAX_FAMILY_LENGTH = 100;

/**
 * Coerces an arbitrary stored/HTTP value into a family name safe to interpolate
 * into CSS.
 *
 * The value ends up inside a quoted `font-family`, and it arrives from
 * `POST /api/settings` — so a string carrying a quote, backslash, semicolon or
 * brace could close the declaration and inject whatever followed. Those are
 * stripped rather than escaped: no real family name contains them, so there is
 * nothing to preserve, and stripping cannot itself produce a new escape.
 */
export function sanitizeFamily(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/["'\\;{}()<>]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_FAMILY_LENGTH);
}

/** One role's stored value → a family name (legacy ids migrated, then sanitised). */
function familyOf(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_ID_FAMILIES, value)) {
    return LEGACY_ID_FAMILIES[value];
  }
  // "" is a real choice (the platform default stack), so only a MISSING key
  // falls back to the built-in default — an explicit empty string is kept.
  return sanitizeFamily(value);
}

/**
 * Coerces an arbitrary stored/HTTP value into a valid selection.
 *
 * A family that is not installed is NOT rejected here. Unlike the old fixed
 * catalog, this file cannot know what the machine has — and a user syncing
 * settings between two PCs would otherwise have their choice erased by whichever
 * machine lacked the font. The picker and `GET /api/appearance/fonts` report
 * installation instead, so a missing font is visible rather than silently
 * discarded.
 */
export function normalizeFontSettings(value: unknown): FontSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_FONT_SETTINGS };
  }
  const v = value as Partial<FontSettings>;
  return {
    sans: v.sans === undefined ? DEFAULT_FONT_SETTINGS.sans : familyOf(v.sans, DEFAULT_FONT_SETTINGS.sans),
    mono: v.mono === undefined ? DEFAULT_FONT_SETTINGS.mono : familyOf(v.mono, DEFAULT_FONT_SETTINGS.mono),
  };
}

/** The CSS stack for a selection. An empty family is the platform default. */
export function fontStackFor(family: string, role: FontRole): string {
  const fallback = role === "sans" ? SANS_FALLBACK : MONO_FALLBACK;
  const clean = sanitizeFamily(family);
  return clean ? `"${clean}", ${fallback}` : fallback;
}
