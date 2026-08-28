import { useSyncExternalStore } from "react";

export type ChatFontSize = "tiny" | "small" | "default" | "large";

const STORAGE_KEY = "pi-web-chat:chat-font-size";
const listeners = new Set<() => void>();

const pixelSizes: Record<ChatFontSize, number> = {
  tiny: 12,
  small: 14,
  default: 15,
  large: 17,
};

function readFontSize(): ChatFontSize {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "tiny" || stored === "small" || stored === "default" || stored === "large") return stored;
  } catch {
    /* local storage is unavailable in private / restricted contexts */
  }
  return "default";
}

let current: ChatFontSize = typeof window === "undefined" ? "default" : readFontSize();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function chatFontSizePixels(size: ChatFontSize): number {
  return pixelSizes[size];
}

export function setChatFontSize(size: ChatFontSize) {
  if (size === current) return;
  current = size;
  try {
    localStorage.setItem(STORAGE_KEY, size);
  } catch {
    /* The in-memory setting remains active for this session. */
  }
  emit();
}

export function useChatFontSize(): ChatFontSize {
  return useSyncExternalStore(subscribe, () => current, () => "default");
}
