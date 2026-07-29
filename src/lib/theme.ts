import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export type ThemePreference = "system" | Theme;

const STORAGE_KEY = "pi-web-chat-theme";
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  // 예전 버전 호환: 키 없음 = 시스템 추종
  return "system";
}

/** 실제 적용 중인 테마 (system이면 OS 설정 반영) */
export function currentTheme(): Theme {
  const pref = readPreference();
  return pref === "system" ? systemTheme() : pref;
}

export function currentPreference(): ThemePreference {
  return readPreference();
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#1c1c1b" : "#f2f0e9");
}

function notify() {
  for (const l of listeners) l();
}

/** 앱 시작 시 1회 호출 (렌더 전) */
export function initTheme() {
  apply(currentTheme());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readPreference() === "system") {
      apply(systemTheme());
      notify();
    }
  });
}

export function setThemePreference(pref: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, pref);
  apply(currentTheme());
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => currentTheme());
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => currentPreference());
}
