import { useSyncExternalStore } from "react";

const LAST_SESSION_KEY = "pi-web-chat:last-session";
/** "1" = 켜짐(기본), "0" = 꺼짐 */
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
 * "새 세션" 버튼 등 사용자가 명시적으로 새 초안을 연 경우, 다음 한 번의
 * resume 리다이렉트를 막는다. (모듈 상태 — 새로고침하면 사라짐)
 */
let suppressResume = false;

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 세션이 URL에 공개(session_bound)될 때마다 기록 */
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

/** 명시적 "새 세션" 동작: 다음 resume 리다이렉트를 한 번 억제 */
export function suppressResumeOnce() {
  suppressResume = true;
}

/** ChatPage가 resume 분기를 건너뛸지 판단 (소모성) */
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
