export type WorkspaceNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function nextWorkspaceTabId(
  ids: readonly string[],
  current: string,
  key: WorkspaceNavigationKey,
): string {
  if (ids.length === 0) return current;
  const index = ids.indexOf(current);
  if (index === -1) return current;

  switch (key) {
    case "Home":
      return ids[0]!;
    case "End":
      return ids[ids.length - 1]!;
    case "ArrowLeft":
      return ids[(index - 1 + ids.length) % ids.length]!;
    case "ArrowRight":
      return ids[(index + 1) % ids.length]!;
  }
}

export function shouldCloseWorkspaceTab(key: string): boolean {
  return key === "Delete" || key === "Backspace";
}

export function nextWorkspaceFocusAfterClose(
  ids: readonly string[],
  active: string,
  closing: string,
): string {
  if (closing !== active) return active;
  // Fixed workspace tabs (Files and Git) are never preview reducer entries.
  // Mirror the reducer's neighbor selection over preview tabs only.
  const previews = ids.filter((id) => id !== "files" && id !== "git");
  const index = previews.indexOf(closing);
  if (index === -1) return active;
  const remaining = previews.filter((id) => id !== closing);
  return remaining[Math.max(index - 1, 0)] ?? "files";
}
