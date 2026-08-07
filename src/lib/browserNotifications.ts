import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pi-web-chat:browser-notifications";
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let enabled = typeof window === "undefined" ? false : readEnabled();

function emit() {
  for (const listener of listeners) listener();
}

function persist(next: boolean) {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* Keep the current-tab preference when storage is unavailable. */
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function setBrowserNotificationsEnabled(next: boolean): Promise<boolean> {
  if (!next) {
    persist(false);
    return false;
  }
  if (!("Notification" in window)) return false;
  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  const granted = permission === "granted";
  persist(granted);
  return granted;
}

export function notifyTaskComplete() {
  if (
    !enabled ||
    typeof document === "undefined" ||
    document.visibilityState !== "hidden" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  new Notification("pi", { body: "Task completed" });
}

export function useBrowserNotifications(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}
