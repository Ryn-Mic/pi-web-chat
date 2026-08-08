import type { UIActiveTodo, UIContentBlock, UIMessage, UITodoTask } from "../shared/protocol.ts";

type AnyMessage = {
  role: string;
  content?: unknown;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};

/** Strip ANSI escape sequences (color/style codes left by extensions like pi-claude-code-ui) */
function stripAnsi(text: string): string {
  // SGR/cursor control: ESC [ ... (terminator a-zA-Z or @~)
  let out = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // OSC (e.g. ESC ] ... BEL)
  out = out.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return stripAnsi(content);
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => stripAnsi((b as { text: string }).text))
      .join("\n");
  }
  return "";
}

/**
 * Convert pi's AgentMessage[] to UI messages.
 * toolResult messages are paired and merged into their toolCall block.
 */
export function serializeMessages(messages: unknown[]): UIMessage[] {
  const msgs = messages as AnyMessage[];

  // toolCallId -> result mapping
  const results = new Map<string, { text: string; isError: boolean; diff?: string; tasks?: UITodoTask[] }>();
  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const details =
        m.details && typeof m.details === "object"
          ? (m.details as Record<string, unknown>)
          : null;
      const diff = details && typeof details.diff === "string" ? details.diff : undefined;
      // todo tool carries the full task list on every result (details.tasks)
      const tasks = Array.isArray(details?.tasks)
        ? (details.tasks as unknown[]).filter(
            (t): t is UITodoTask =>
              !!t &&
              typeof (t as UITodoTask).id === "number" &&
              typeof (t as UITodoTask).subject === "string",
          )
        : undefined;
      results.set(m.toolCallId, {
        text: textFromContent(m.content),
        isError: m.isError === true,
        ...(diff ? { diff } : {}),
        ...(tasks && tasks.length > 0 ? { tasks } : {}),
      });
    }
  }

  const out: UIMessage[] = [];
  for (const m of msgs) {
    if (m.role === "toolResult") continue; // merged into toolCall

    if (m.role === "user") {
      const blocks: UIContentBlock[] = [];
      if (typeof m.content === "string") {
        blocks.push({ type: "text", text: stripAnsi(m.content) });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content as { type: string; text?: string; data?: string; mimeType?: string }[]) {
          if (b.type === "text" && b.text) blocks.push({ type: "text", text: stripAnsi(b.text) });
          else if (b.type === "image") {
            blocks.push({
              type: "image",
              dataUrl:
                b.data && b.mimeType ? `data:${b.mimeType};base64,${b.data}` : undefined,
            });
          }
        }
      }
      if (blocks.length > 0) {
        out.push({
          role: "user",
          content: blocks,
          timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
        });
      }
      continue;
    }

    if (m.role === "assistant") {
      const blocks: UIContentBlock[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content as Record<string, unknown>[]) {
          if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
            blocks.push({ type: "text", text: stripAnsi(b.text) });
          } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0) {
            blocks.push({ type: "thinking", text: b.thinking });
          } else if (b.type === "toolCall") {
            const id = String(b.id ?? "");
            blocks.push({
              type: "toolCall",
              id,
              name: String(b.name ?? "unknown"),
              args: b.arguments,
              result: results.get(id),
            });
          }
        }
      }
      if (blocks.length > 0 || m.errorMessage) {
        out.push({
          role: "assistant",
          content: blocks,
          errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
          timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
        });
      }
      continue;
    }

    // custom/other messages: show when there is text
    const text = textFromContent(m.content);
    if (text) {
      out.push({
        role: "custom",
        content: [{ type: "text", text }],
        timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      });
    }
  }

  return out;
}

/** Find the live or final completed task from the most recent todo snapshot. */
export function getActiveTodo(messages: UIMessage[]): UIActiveTodo | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant") continue;

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block?.type !== "toolCall" || block.name !== "todo") continue;
      const tasks = block.result?.tasks;
      if (!tasks?.length) continue;

      const current = tasks.findIndex((task) => task.status === "in_progress");
      if (current >= 0) {
        const task = tasks[current];
        if (!task) continue;
        return {
          subject: task.subject,
          activeForm: task.activeForm,
          status: "in_progress",
          current: current + 1,
          total: tasks.length,
        };
      }

      // Preserve the completed state for the final snapshot so the UI can
      // show a stable green indicator instead of hiding the todo immediately.
      if (!tasks.every((task) => task.status === "completed")) return undefined;
      const lastTask = tasks[tasks.length - 1];
      if (!lastTask) continue;
      return {
        subject: lastTask.subject,
        activeForm: lastTask.activeForm,
        status: "completed",
        current: tasks.length,
        total: tasks.length,
      };
    }
  }
  return undefined;
}
