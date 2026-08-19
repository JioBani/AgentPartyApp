export const APP_LOCALES = ["ko", "en"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = "ko";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (APP_LOCALES as readonly string[]).includes(value);
}

/** Heals a missing or stale value read from settings.json. */
export function normalizeAppLocale(value: unknown): AppLocale {
  return isAppLocale(value) ? value : DEFAULT_APP_LOCALE;
}

/** Validates an explicit user/API choice instead of silently changing it. */
export function requireAppLocale(value: unknown): AppLocale {
  if (!isAppLocale(value)) {
    throw new Error(`지원하지 않는 앱 언어입니다: ${String(value ?? "")}`);
  }
  return value;
}
