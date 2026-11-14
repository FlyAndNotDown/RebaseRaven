import { createInstance } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };

import gitFilesEn from "../../src/i18n/locales/git-files.en.json" with { type: "json" };
import gitFilesZhCN from "../../src/i18n/locales/git-files.zh-CN.json" with { type: "json" };
import p4En from "../../src/i18n/locales/p4.en.json" with { type: "json" };
import p4ZhCN from "../../src/i18n/locales/p4.zh-CN.json" with { type: "json" };

function flattenMessages(prefix: string, source: object): Record<string, string> {
  return Object.fromEntries(Object.entries(source).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}.${key}`, value]] : Object.entries(flattenMessages(`${prefix}.${key}`, value))));
}

export const SITE_LOCALES = ["en", "zh-CN"] as const;
export type SiteLocale = typeof SITE_LOCALES[number];
// Shared product components use the same labels in the app and browser demo.
export const siteResources: Record<SiteLocale, Record<string, string>> = {
  en: { ...flattenMessages("git-files", gitFilesEn), ...flattenMessages("p4", p4En), ...en },
  "zh-CN": { ...flattenMessages("git-files", gitFilesZhCN), ...flattenMessages("p4", p4ZhCN), ...zhCN },
};

export function isSiteLocale(value: unknown): value is SiteLocale {
  return SITE_LOCALES.some((locale) => locale === value);
}

export function browserLocale(languages: readonly string[]): SiteLocale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}

export function localeFromPath(pathname: string): SiteLocale | null {
  const last = pathname.replace(/\/index\.html$/, "/").replace(/\/+$/, "").split("/").at(-1);
  return isSiteLocale(last) ? last : null;
}

export function localeHref(locale: SiteLocale, rootPage: boolean) {
  return `${rootPage ? "./" : "../"}${localePath(locale)}`;
}

export function localePath(locale: SiteLocale) {
  return locale === "en" ? "" : `${locale}/`;
}

export function createSiteI18n(locale: SiteLocale) {
  const instance = createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: "en",
    supportedLngs: [...SITE_LOCALES],
    resources: { en: { translation: siteResources.en }, "zh-CN": { translation: siteResources["zh-CN"] } },
    initAsync: false,
    keySeparator: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}
