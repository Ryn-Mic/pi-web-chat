export type ActivityDotState = "running" | "waiting" | "error" | "idle";
export type ConnectionState = "connecting" | "connected" | "disconnected";

export function activityDotClass(state: ActivityDotState, animated = true): string {
  switch (state) {
    case "running":
      return `bg-emerald-500/80${animated ? " animate-pulse" : ""}`;
    case "waiting":
      return `bg-amber-400${animated ? " animate-pulse" : ""}`;
    case "error":
      return "bg-red-500";
    case "idle":
      return "bg-zinc-400/80 dark:bg-zinc-500/80";
  }
}

export function connectionActivity(
  connection: ConnectionState,
  running: boolean,
): ActivityDotState {
  if (connection === "disconnected") return "error";
  if (connection === "connecting") return "waiting";
  return running ? "running" : "idle";
}
