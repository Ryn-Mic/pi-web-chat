import { useSyncExternalStore } from "react";

const LAST_SESSION_KEY = "pi-web-chat:last-session";
/** "1" = on (default), "0" = off */
const ENABLED_KEY = "pi-web-chat:resume-session";
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

let enabled = typeof window !== "undefined" ? readEnabled() : true;
let lastId = typeof window !== "undefined" ? readLast() : null;
/**
 * When the user explicitly opened a fresh draft (new-session button etc.),
 * suppress the next resume redirect once. (Module state — lost on reload.)
 */
let suppressResume = false;

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record the id whenever a session is published in the URL (session_bound) */
export function rememberSessionId(id: string) {
  lastId = id;
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
}

export function getLastSessionId(): string | null {
  return lastId;
}

/** Explicit "new session": suppress the next resume redirect once */
export function suppressResumeOnce() {
  suppressResume = true;
}

/** Whether ChatPage should skip the resume branch (consuming) */
export function consumeSuppressResume(): boolean {
  if (!suppressResume) return false;
  suppressResume = false;
  return true;
}

export function isResumeEnabled(): boolean {
  return enabled;
}

export function setResumeEnabled(value: boolean) {
  enabled = value;
  try {
    localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit();
}

export function useResumeEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => true);
}
