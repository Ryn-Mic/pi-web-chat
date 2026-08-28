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
  // Backward compatibility: missing key = follow the system
  return "system";
}

/** Theme actually in effect (system reflects the OS setting) */
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

/** Called once at app start (before first render) */
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
