import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { DEFAULT_APP_LOCALE, type AppLocale } from "../../shared/appLocale";
import { enMessages, koMessages, type MessageKey, type MessageValues } from "./messages";

export interface I18nValue {
  locale: AppLocale;
  t: (key: MessageKey, values?: MessageValues) => string;
}

export function createI18n(locale: AppLocale): I18nValue {
  const messages = locale === "en" ? enMessages : koMessages;
  return {
    locale,
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
  const value = useMemo(() => createI18n(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
