import type { UIContentBlock } from "../../shared/protocol";

export type ToolCallBlock = Extract<UIContentBlock, { type: "toolCall" }>;
type ToolCallResult = ToolCallBlock["result"];

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
