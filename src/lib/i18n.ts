import { useSyncExternalStore } from "react";
import { en, type Messages } from "../i18n/en";
import { ja } from "../i18n/ja";
import { ko } from "../i18n/ko";
import { zh } from "../i18n/zh";

export type Locale = "ko" | "en" | "ja" | "zh";

export const LOCALES: { value: Locale; label: string; nativeLabel: string; flag: string }[] = [
  { value: "zh", label: "Chinese", nativeLabel: "中文", flag: "🇨🇳" },
  { value: "ko", label: "Korean", nativeLabel: "한국어", flag: "🇰🇷" },
  { value: "en", label: "English", nativeLabel: "English", flag: "🇺🇸" },
  { value: "ja", label: "Japanese", nativeLabel: "日本語", flag: "🇯🇵" },
];

const STORAGE_KEY = "pi-web-chat-locale";
const catalogs: Record<Locale, Messages> = { ko, en, ja, zh };
const localeSet = new Set<string>(LOCALES.map((l) => l.value));
const listeners = new Set<() => void>();

const LOCALE_TAGS: Record<Locale, string> = {
  ko: "ko-KR",
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-CN",
};

function notify() {
  for (const l of listeners) l();
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && localeSet.has(value);
}

function browserLocale(): Locale {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const raw of langs) {
    const code = raw.toLowerCase();
    if (code === "ko" || code.startsWith("ko-")) return "ko";
    if (code === "ja" || code.startsWith("ja-")) return "ja";
    if (code === "zh" || code.startsWith("zh-")) return "zh";
    if (code === "en" || code.startsWith("en-")) return "en";
  }
  return "en";
}

function readLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  return browserLocale();
}

let current: Locale = "en";

/** Called once at app start (before first render) */
export function initLocale() {
  current = readLocale();
  document.documentElement.lang = current === "zh" ? "zh-CN" : current;
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale) {
  if (locale === current) return;
  current = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
  notify();
}

export function getMessages(locale: Locale = current): Messages {
  return catalogs[locale] ?? catalogs.en;
}

type Vars = Record<string, string | number>;

/** Simple template: "Hello {name}" + { name: "a" } → "Hello a" */
export function t(key: keyof Messages, vars?: Vars, locale: Locale = current): string {
  const template = getMessages(locale)[key] ?? getMessages("en")[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => current, () => "en");
}

/** Translation function for the current locale. Re-renders on locale change. */
export function useT() {
  const locale = useLocale();
  return (key: keyof Messages, vars?: Vars) => t(key, vars, locale);
}

/** BCP 47 tag for date/time display */
export function localeTag(locale: Locale = current): string {
  return LOCALE_TAGS[locale] ?? "en-US";
}
