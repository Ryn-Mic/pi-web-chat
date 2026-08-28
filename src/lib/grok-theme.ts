import { useSyncExternalStore } from "react";
import type { ActivityDotState } from "./activity";
import type { GrokEyeState } from "./grok-eyes";

export type GrokTheme = "classic" | "cyberpunk" | "matrix" | "amber" | "sakura";
export type GrokPersona = "playful" | "analytic" | "zen" | "cyber";

const THEME_STORAGE_KEY = "pi-web-chat-grok-theme";
const PI_PERSONA_KEY = "pi-web-chat-pi-persona";
const CODEX_PERSONA_KEY = "pi-web-chat-codex-persona";

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function isGrokTheme(val: unknown): val is GrokTheme {
  return val === "classic" || val === "cyberpunk" || val === "matrix" || val === "amber" || val === "sakura";
}

function isGrokPersona(val: unknown): val is GrokPersona {
  return val === "playful" || val === "analytic" || val === "zen" || val === "cyber";
}

function readTheme(): GrokTheme {
  if (typeof localStorage === "undefined") return "classic";
  const val = localStorage.getItem(THEME_STORAGE_KEY);
  return isGrokTheme(val) ? val : "classic";
}

function readPiPersona(): GrokPersona {
  if (typeof localStorage === "undefined") return "playful";
  const val = localStorage.getItem(PI_PERSONA_KEY);
  return isGrokPersona(val) ? val : "playful";
}

function readCodexPersona(): GrokPersona {
  if (typeof localStorage === "undefined") return "analytic";
  const val = localStorage.getItem(CODEX_PERSONA_KEY);
  return isGrokPersona(val) ? val : "analytic";
}

let currentTheme: GrokTheme = readTheme();
let currentPiPersona: GrokPersona = readPiPersona();
let currentCodexPersona: GrokPersona = readCodexPersona();

export function getGrokTheme(): GrokTheme {
  return currentTheme;
}

export function setGrokTheme(theme: GrokTheme) {
  if (theme === currentTheme) return;
  currentTheme = theme;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
  notify();
}

export function useGrokTheme(): GrokTheme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => currentTheme,
    () => "classic",
  );
}

export function getPiPersona(): GrokPersona {
  return currentPiPersona;
}

export function setPiPersona(persona: GrokPersona) {
  if (persona === currentPiPersona) return;
  currentPiPersona = persona;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(PI_PERSONA_KEY, persona);
  }
  notify();
}

export function usePiPersona(): GrokPersona {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => currentPiPersona,
    () => "playful",
  );
}

export function getCodexPersona(): GrokPersona {
  return currentCodexPersona;
}

export function setCodexPersona(persona: GrokPersona) {
  if (persona === currentCodexPersona) return;
  currentCodexPersona = persona;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(CODEX_PERSONA_KEY, persona);
  }
  notify();
}

export function useCodexPersona(): GrokPersona {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => currentCodexPersona,
    () => "analytic",
  );
}

/** Color map for each theme across the 4 activity states */
export const GROK_THEME_PALETTES: Record<
  GrokTheme,
  Record<ActivityDotState, string>
> = {
  classic: {
    idle: "text-sky-500/85 dark:text-sky-400/90",
    running: "text-emerald-500",
    waiting: "text-amber-400",
    error: "text-red-500",
  },
  cyberpunk: {
    idle: "text-cyan-400",
    running: "text-fuchsia-500 dark:text-fuchsia-400",
    waiting: "text-yellow-400",
    error: "text-rose-500",
  },
  matrix: {
    idle: "text-emerald-400/80",
    running: "text-lime-500 dark:text-lime-400",
    waiting: "text-teal-400",
    error: "text-red-400",
  },
  amber: {
    idle: "text-amber-500/85 dark:text-amber-400/90",
    running: "text-orange-500",
    waiting: "text-amber-300",
    error: "text-rose-500",
  },
  sakura: {
    idle: "text-pink-400/85 dark:text-pink-300/90",
    running: "text-rose-500 dark:text-rose-400",
    waiting: "text-violet-400",
    error: "text-red-400",
  },
};

/**
 * Persona expression & motion pools for GrokBot.
 * Different agent personas have distinctly tuned eye expressions, cadence, and motions.
 */
export const GROK_PERSONA_SPECS: Record<
  GrokPersona,
  Record<
    GrokEyeState,
    {
      pool: number[];
      morphEveryMs?: [number, number];
      blink?: [number, number];
      motion: string;
    }
  >
> = {
  playful: {
    idle: { pool: [0, 8, 14, 21, 24], morphEveryMs: [4500, 9000], blink: [4000, 8000], motion: "bounce" },
    thinking: { pool: [17, 14, 5, 2], morphEveryMs: [1800, 3200], blink: [3000, 6000], motion: "tilt" },
    working: { pool: [7, 11, 10, 16], morphEveryMs: [1600, 2800], blink: [2500, 5000], motion: "scan" },
    searching: { pool: [15, 9, 3, 20, 12, 18], morphEveryMs: [1000, 1800], blink: [1600, 4000], motion: "scan" },
    loading: { pool: [0, 8, 14], morphEveryMs: [5000, 9000], motion: "pulse" },
    happy: { pool: [2, 11, 19, 17], morphEveryMs: [2000, 4000], blink: [2000, 4500], motion: "bounce" },
    sending: { pool: [0, 8, 2], morphEveryMs: [3500, 7000], motion: "bounce" },
    connecting: { pool: [3, 0], morphEveryMs: [1000, 1000], motion: "pulse" },
    error: { pool: [7, 16], morphEveryMs: [2000, 3500], blink: [2000, 3500], motion: "glitch" },
    sleeping: { pool: [13, 22, 4], morphEveryMs: [6000, 10000], motion: "pulse" },
  },
  analytic: {
    idle: { pool: [0, 8, 16, 9], morphEveryMs: [6000, 12000], blink: [5000, 10000], motion: "scan" },
    thinking: { pool: [10, 16, 5, 17], morphEveryMs: [2000, 3600], blink: [3500, 7000], motion: "pulse" },
    working: { pool: [1, 9, 10, 16], morphEveryMs: [1500, 2800], blink: [2500, 5000], motion: "scan" },
    searching: { pool: [16, 20, 9, 12], morphEveryMs: [1000, 1800], blink: [1500, 3500], motion: "scan" },
    loading: { pool: [8, 16], morphEveryMs: [5000, 9000], motion: "pulse" },
    happy: { pool: [0, 2, 8, 21], morphEveryMs: [2500, 4500], blink: [2500, 5000], motion: "pulse" },
    sending: { pool: [8, 16], morphEveryMs: [3500, 7000], motion: "pulse" },
    connecting: { pool: [9, 0], morphEveryMs: [1000, 1000], motion: "scan" },
    error: { pool: [7, 16], morphEveryMs: [2000, 3500], blink: [2000, 3500], motion: "glitch" },
    sleeping: { pool: [4, 13], morphEveryMs: [6000, 10000], motion: "pulse" },
  },
  zen: {
    idle: { pool: [0, 21, 22, 8], morphEveryMs: [8000, 16000], blink: [6000, 14000], motion: "pulse" },
    thinking: { pool: [8, 14, 21], morphEveryMs: [3000, 5000], blink: [4000, 8000], motion: "tilt" },
    working: { pool: [0, 16, 21], morphEveryMs: [2500, 4500], blink: [3000, 6000], motion: "pulse" },
    searching: { pool: [9, 21, 15], morphEveryMs: [1500, 2500], blink: [2000, 5000], motion: "scan" },
    loading: { pool: [0, 21], morphEveryMs: [7000, 12000], motion: "pulse" },
    happy: { pool: [2, 21, 11], morphEveryMs: [3000, 6000], blink: [3000, 6000], motion: "pulse" },
    sending: { pool: [0, 21], morphEveryMs: [4500, 9000], motion: "pulse" },
    connecting: { pool: [0, 21], morphEveryMs: [1200, 1200], motion: "pulse" },
    error: { pool: [7, 16], morphEveryMs: [2500, 4000], blink: [2500, 4000], motion: "glitch" },
    sleeping: { pool: [4, 22, 13], morphEveryMs: [8000, 14000], motion: "pulse" },
  },
  cyber: {
    idle: { pool: [9, 10, 16, 0], morphEveryMs: [4000, 8000], blink: [3500, 7000], motion: "glitch" },
    thinking: { pool: [12, 18, 16, 20], morphEveryMs: [1200, 2400], blink: [2000, 4500], motion: "scan" },
    working: { pool: [9, 10, 12, 18], morphEveryMs: [1000, 2000], blink: [2000, 4000], motion: "glitch" },
    searching: { pool: [18, 20, 12, 9], morphEveryMs: [800, 1500], blink: [1200, 3000], motion: "scan" },
    loading: { pool: [9, 10], morphEveryMs: [4000, 8000], motion: "glitch" },
    happy: { pool: [11, 19, 16], morphEveryMs: [1800, 3500], blink: [1800, 4000], motion: "bounce" },
    sending: { pool: [10, 16], morphEveryMs: [2500, 5000], motion: "pulse" },
    connecting: { pool: [9, 16], morphEveryMs: [800, 800], motion: "glitch" },
    error: { pool: [7, 16, 9], morphEveryMs: [1500, 3000], blink: [1500, 3000], motion: "glitch" },
    sleeping: { pool: [4, 9], morphEveryMs: [5000, 9000], motion: "pulse" },
  },
};
