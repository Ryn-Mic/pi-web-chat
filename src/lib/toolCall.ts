import type { UIContentBlock } from "../../shared/protocol";

export type ToolCallBlock = Extract<UIContentBlock, { type: "toolCall" }>;
type ToolCallResult = ToolCallBlock["result"];

/** Collapsed label for the specific todo mutation represented by one call. */
export function todoCallSummary(block: ToolCallBlock): string | null {
  if (block.name !== "todo" || !block.args || typeof block.args !== "object") return null;
  const args = block.args as { action?: unknown; id?: unknown; subject?: unknown };
  const action = typeof args.action === "string" ? args.action : null;
  if (!action) return null;

  if (action === "create" && typeof args.subject === "string" && args.subject.trim()) {
    return `create · ${args.subject.trim()}`;
  }

  const id = typeof args.id === "number" ? args.id : null;
  if (id !== null) {
    const task = block.result?.tasks?.find((candidate) => candidate.id === id);
    return `${action} · #${id}${task?.subject ? ` ${task.subject}` : ""}`;
  }

  if (action === "list") {
    const tasks = block.result?.tasks ?? [];
    if (tasks.length > 0) {
      const done = tasks.filter((task) => task.status === "completed").length;
      const current = tasks.find((task) => task.status === "in_progress");
      return `list · ${done}/${tasks.length}${current?.activeForm ? ` · ${current.activeForm}` : ""}`;
    }
  }

  return action;
}

/**
 * Tool results are rebuilt on every server snapshot (server/serialize.ts creates
 * a fresh result object per call), so reference equality never holds. Compare
 * the fields the tool card actually renders instead.
 */
export function sameToolResult(a: ToolCallResult, b: ToolCallResult): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.text !== b.text || a.isError !== b.isError || a.diff !== b.diff) return false;

  const aTasks = a.tasks;
  const bTasks = b.tasks;
  if (aTasks === bTasks) return true;
  if (!aTasks || !bTasks || aTasks.length !== bTasks.length) return false;
  return aTasks.every((task, i) => {
    const other = bTasks[i];
    return (
      !!other &&
      task.id === other.id &&
      task.status === other.status &&
      task.subject === other.subject &&
      task.activeForm === other.activeForm
    );
  });
}

/**
 * Memo comparator for the tool call card.
 *
 * `args` keeps the agent's original object reference across snapshots (see
 * server/serialize.ts, which passes `b.arguments` straight through), so a plain
 * reference check is both correct and the cheapest possible test.
 */
export function sameToolCallBlock(a: ToolCallBlock, b: ToolCallBlock): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.args === b.args &&
    sameToolResult(a.result, b.result)
  );
}
