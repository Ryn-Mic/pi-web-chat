import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pi-web-chat-composer-opacity";
const listeners = new Set<() => void>();

/** Composer panel background opacity (0.4 = 40%, 1 = fully opaque). */
export const COMPOSER_OPACITY = { min: 0.4, max: 1, step: 0.05 } as const;

function read(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  const v = stored ? Number(stored) : NaN;
  if (Number.isFinite(v) && v >= COMPOSER_OPACITY.min && v <= COMPOSER_OPACITY.max) return v;
  return COMPOSER_OPACITY.max;
}

let current = typeof window !== "undefined" ? read() : COMPOSER_OPACITY.max;

function emit() {
  for (const l of listeners) l();
}

export function setComposerOpacity(value: number) {
  const clamped = Math.min(COMPOSER_OPACITY.max, Math.max(COMPOSER_OPACITY.min, value));
  current = clamped;
  try {
    localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {
    /* ignore */
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useComposerOpacity(): number {
  return useSyncExternalStore(subscribe, () => current, () => COMPOSER_OPACITY.max);
}
