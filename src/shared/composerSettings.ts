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
  /**
   * Whether pressing Send stops the member's in-flight turn so the message is
   * handled now, instead of queueing behind it.
   *
   * Scoped to the composer on purpose. Every other caller of the send path
   * already states `interrupt` for itself — the Discord bridge always sets it
   * (a person typed on their phone and is waiting), and an agent driving
   * `POST /api/party/members/:name/message` passes it per call. An explicit
   * value therefore always wins; this only fills in the one caller that has
   * none, the Send button.
   */
  interruptOnSend: boolean;
}

/**
 * Built-in defaults, both chosen to keep the behaviour users already have:
 * - `ctrl-enter` because changing the send key under them silently breaks a
 *   reflex they built (a half-typed line would ship on Enter).
 * - `interruptOnSend: false` because interrupting kills a turn that is already
 *   doing work; a destructive action cannot be the default.
 */
export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = { sendKey: "ctrl-enter", interruptOnSend: false };

/** Coerces an arbitrary stored/HTTP value into a valid setting (defaults fill gaps). */
export function normalizeComposerSettings(value: unknown): ComposerSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_COMPOSER_SETTINGS };
  }
  const v = value as Partial<ComposerSettings>;
  return {
    sendKey: COMPOSER_SEND_KEYS.includes(v.sendKey as ComposerSendKey) ? (v.sendKey as ComposerSendKey) : DEFAULT_COMPOSER_SETTINGS.sendKey,
    interruptOnSend: typeof v.interruptOnSend === "boolean" ? v.interruptOnSend : DEFAULT_COMPOSER_SETTINGS.interruptOnSend,
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

/**
 * Whether this keystroke ALSO means "do not wait your turn" — park the message
 * at the front of the queue and stop the member's in-flight turn.
 *
 * It must be the send gesture PLUS something the user cannot press by accident.
 * Under `enter` that extra is Ctrl/Cmd; under `ctrl-enter` Ctrl/Cmd IS the send
 * key, so the extra is Shift.
 *
 * Reading "Ctrl/Cmd is held" as the intent — which is what this used to do —
 * made the DEFAULT send gesture a turn-stopping one: every ordinary message to
 * a busy member interrupted it, and {@link ComposerSettings.interruptOnSend},
 * which exists precisely so that destructive behaviour is opt-in, could never
 * be observed by anyone on the default send key.
 */
export function sendsImmediately(setting: ComposerSendKey, modifiers: { ctrlOrMeta: boolean; shift: boolean }): boolean {
  if (!sendsOnEnter(setting, modifiers)) {
    return false;
  }
  return setting === "enter" ? modifiers.ctrlOrMeta : modifiers.ctrlOrMeta && modifiers.shift;
}
