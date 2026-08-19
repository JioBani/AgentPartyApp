import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { DEFAULT_APP_LOCALE, type AppLocale } from "../../shared/appLocale";
import { enMessages, koMessages, type MessageKey, type MessageValues } from "./messages";
import { auditKoMessages, type AuditMessageKey } from "./auditKoMessages";

export interface I18nValue {
  locale: AppLocale;
  t: (key: MessageKey, values?: MessageValues) => string;
  audit: (key: AuditMessageKey) => string;
}

let activeLocale: AppLocale = DEFAULT_APP_LOCALE;

function auditMessage(_locale: AppLocale, key: AuditMessageKey, values: readonly unknown[] = []): string {
  let index = 0;
  return (auditKoMessages[key] || key).replaceAll("${…}", () => String(values[index++] ?? ""));
}

export function createI18n(locale: AppLocale): I18nValue {
  const messages = locale === "en" ? enMessages : koMessages;
  return {
    locale,
    audit: (key) => auditMessage(locale, key),
    t: (key, values) => {
      let message = messages[key] || koMessages[key] || key;
      for (const [name, value] of Object.entries(values || {})) {
        message = message.replaceAll(`{${name}}`, String(value));
      }
      return message;
    },
  };
}

const I18nContext = createContext<I18nValue>(createI18n(DEFAULT_APP_LOCALE));

export function I18nProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  activeLocale = locale;
  const value = useMemo(() => createI18n(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function LocalizedText({ id }: { id: AuditMessageKey }) {
  const { audit } = useI18n();
  return <>{audit(id)}</>;
}

export function localized(id: AuditMessageKey, values?: readonly unknown[]): string {
  return auditMessage(activeLocale, id, values);
}
