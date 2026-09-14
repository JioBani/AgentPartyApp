import { localized } from "../i18n/I18nProvider";

/** What member creation tells the wizard: done, or the one line to show inside it. */
export type MemberCreateResult = { ok: true } | { ok: false; reason: string };

/**
 * Turns a creation failure into the one line the wizard shows.
 *
 * The backend speaks to agents too (MCP `member-create`), so its tab-group and
 * duplicate-name errors name ids and tools. A person needs what failed and what
 * to do instead; reasons the backend already writes for people (SSH harness,
 * beta lock) are Korean sentences and pass through unchanged.
 */
export function memberCreateFailureText(name: string, message: string): string {
  if (/^Tab group\b/.test(message)) return localized("STR-4226");
  if (/already exists/.test(message)) return localized("STR-4227", [name]);
  if (/[가-힣]/.test(message)) return message;
  return `${localized("STR-0771", [name])}: ${message}`;
}
