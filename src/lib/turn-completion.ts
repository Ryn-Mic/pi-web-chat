import type { UIContentBlock, UIMessage } from "../../shared/protocol";

const TURN_DURATION_LINE = /^\s*(?:✻\s+)?Turn took\s+.+\s*$/;

export type AssistantTurnCompletion = {
  content: UIContentBlock[];
  summary: string;
};

/** Remove the extension's final duration line so it can be rendered as metadata. */
export function splitAssistantTurnCompletion(
  content: UIContentBlock[],
): AssistantTurnCompletion | null {
  for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = content[blockIndex];
    if (!block || block.type !== "text" || !block.text.trim()) continue;

    const lines = block.text.split(/\r?\n/);
    let lineIndex = lines.length - 1;
    while (lineIndex >= 0 && !lines[lineIndex]?.trim()) lineIndex -= 1;
    const summary = lines[lineIndex]?.trim() ?? "";
    if (!TURN_DURATION_LINE.test(summary)) return null;

    const remainingText = lines.slice(0, lineIndex).join("\n").trimEnd();
    const nextContent = content.slice();
    if (remainingText) {
      nextContent[blockIndex] = { ...block, text: remainingText };
    } else {
      nextContent.splice(blockIndex, 1);
    }
    return { content: nextContent, summary };
  }
  return null;
}

/** A prior turn is complete once the next user prompt exists; the active turn waits for agent_end. */
export function isAssistantTurnComplete(
  messages: UIMessage[],
  index: number,
  isStreaming: boolean,
): boolean {
  if (messages[index]?.role !== "assistant") return false;
  for (let i = index + 1; i < messages.length; i += 1) {
    const role = messages[i]?.role;
    if (role === "user") return true;
    if (role === "assistant") return false;
  }
  return !isStreaming;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local turn completion time; omit the date when it falls on today. */
export function formatTurnCompletedAt(timestamp: number, now = Date.now()): string {
  const completed = new Date(timestamp);
  const current = new Date(now);
  if (!Number.isFinite(completed.getTime())) return "";

  const time = `${twoDigits(completed.getHours())}:${twoDigits(completed.getMinutes())}:${twoDigits(completed.getSeconds())}`;
  const isToday =
    completed.getFullYear() === current.getFullYear() &&
    completed.getMonth() === current.getMonth() &&
    completed.getDate() === current.getDate();
  if (isToday) return time;

  const year = twoDigits(completed.getFullYear() % 100);
  return `${year}/${completed.getMonth() + 1}/${completed.getDate()} ${time}`;
}
