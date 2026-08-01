/**
 * Composer (message input) preferences — global, edited in Settings → Runtime.
 *
 * Single source of truth for the shape, the built-in defaults and the coercion
 * of an arbitrary stored/HTTP value, so main (persistence) and renderer (the
 * input itself) can never disagree. Pure logic — no I/O — and unit-testable.
 */

/**
 * Which keystroke sends the draft.
 * - `ctrl-enter` — Ctrl/Cmd+Enter sends, Enter inserts a newline (the default).
 * - `enter` — Enter sends, Shift+Enter inserts a newline.
 */
export type ComposerSendKey = "ctrl-enter" | "enter";

export const COMPOSER_SEND_KEYS: ComposerSendKey[] = ["ctrl-enter", "enter"];

export interface ComposerSettings {
  /** Which keystroke sends the draft. */
  sendKey: ComposerSendKey;
}

/**
 * Built-in defaults, chosen to keep the behaviour existing users already have:
 * `ctrl-enter` because changing the send key under them silently breaks a
 * reflex they built (a half-typed line would ship on Enter).
 */
export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = { sendKey: "ctrl-enter" };

/** Coerces an arbitrary stored/HTTP value into a valid setting (defaults fill gaps). */
export function normalizeComposerSettings(value: unknown): ComposerSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_COMPOSER_SETTINGS };
  }
  const v = value as Partial<ComposerSettings>;
  return {
    sendKey: COMPOSER_SEND_KEYS.includes(v.sendKey as ComposerSendKey) ? (v.sendKey as ComposerSendKey) : DEFAULT_COMPOSER_SETTINGS.sendKey,
  };
}

/**
 * Whether an Enter keystroke should send, given the send key setting and the
 * modifiers held. Shared by the two-row textarea and the narrow single-line
 * input so composer width can never change what Enter does (see FEEDBACK #15).
 */
export function sendsOnEnter(setting: ComposerSendKey, modifiers: { ctrlOrMeta: boolean; shift: boolean }): boolean {
  if (modifiers.ctrlOrMeta) {
    // Ctrl/Cmd+Enter sends under both settings — it is the universal "send now".
    return true;
  }
  return setting === "enter" && !modifiers.shift;
}
