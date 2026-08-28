import type { GrokEyeState } from "./grok-eyes";
import { getGrokTheme, GROK_THEME_PALETTES, type GrokTheme } from "./grok-theme";

export type ActivityDotState = "running" | "waiting" | "error" | "idle";
export type ConnectionState = "connecting" | "connected" | "disconnected";

export function connectionActivity(
  connection: ConnectionState,
  running: boolean,
): ActivityDotState {
  if (connection === "disconnected") return "error";
  if (connection === "connecting") return "waiting";
  return running ? "running" : "idle";
}

/** Map an activity state to a GrokBot eye expression for AgentEyes. */
export function activityEyeState(state: ActivityDotState): GrokEyeState {
  switch (state) {
    case "running":
      return "working";
    case "waiting":
      return "thinking";
    case "error":
      return "error";
    case "idle":
      return "idle";
  }
}

/** Tone color for AgentEyes, resolving by theme. */
export function activityEyeTone(state: ActivityDotState, theme?: GrokTheme): string {
  const currentTheme = theme ?? getGrokTheme();
  return GROK_THEME_PALETTES[currentTheme]?.[state] ?? GROK_THEME_PALETTES.classic[state];
}
