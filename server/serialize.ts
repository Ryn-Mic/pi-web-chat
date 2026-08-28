import type { UIActiveTodo, UIContentBlock, UIMessage, UITodoTask } from "../shared/protocol.ts";

type AnyMessage = {
  role: string;
  content?: unknown;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};

type SerializedResult = {
  text: string;
  isError: boolean;
  diff?: string;
  tasks?: UITodoTask[];
};

/**
 * Serialized tool results, keyed on the source `toolResult` message.
 *
 * pi appends messages to `agent.state.messages` on `message_end` and never
 * mutates them afterwards (streaming content lives in `state.streamingMessage`),
 * so a message object reference is a safe cache key. A WeakMap also means the
 * cache is collected together with the session — no eviction policy needed.
 */
const resultBySource = new WeakMap<object, SerializedResult>();

type CachedMessage = {
  /** Results the tool calls in this message resolved to when it was serialized. */
  results: (SerializedResult | undefined)[];
  /** `null` for messages that render to nothing (e.g. empty user content). */
  ui: UIMessage | null;
};

/** Serialized UI messages, keyed on the source message. */
const uiBySource = new WeakMap<object, CachedMessage>();

/** True message completion times, including timestamps restored from session entries. */
const completedAtBySource = new WeakMap<object, number>();

export function recordMessageCompletion(message: unknown, completedAt = Date.now()): void {
  if (!message || typeof message !== "object" || !Number.isFinite(completedAt)) return;
  completedAtBySource.set(message, completedAt);
  // message_end can arrive after an earlier snapshot serialized this object.
  uiBySource.delete(message);
}

export function recordSessionMessageCompletions(entries: unknown[]): void {
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { type?: unknown; timestamp?: unknown; message?: unknown };
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const completedAt =
      typeof entry.timestamp === "number"
        ? entry.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : Number.NaN;
    recordMessageCompletion(entry.message, completedAt);
  }
}

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

function serializeResult(m: AnyMessage): SerializedResult {
  const details =
    m.details && typeof m.details === "object" ? (m.details as Record<string, unknown>) : null;
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
  return {
    text: textFromContent(m.content),
    isError: m.isError === true,
    ...(diff ? { diff } : {}),
    ...(tasks && tasks.length > 0 ? { tasks } : {}),
  };
}

/** Results the tool calls in this message resolve to, in block order. */
function resultsForMessage(
  m: AnyMessage,
  results: Map<string, SerializedResult>,
): (SerializedResult | undefined)[] {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
  const out: (SerializedResult | undefined)[] = [];
  for (const b of m.content as Record<string, unknown>[]) {
    if (b.type === "toolCall") out.push(results.get(String(b.id ?? "")));
  }
  return out;
}

function sameResults(
  a: (SerializedResult | undefined)[],
  b: (SerializedResult | undefined)[],
): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/** Convert one pi message; returns null when it renders to nothing. */
function serializeMessage(
  m: AnyMessage,
  results: Map<string, SerializedResult>,
): UIMessage | null {
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
            dataUrl: b.data && b.mimeType ? `data:${b.mimeType};base64,${b.data}` : undefined,
          });
        }
      }
    }
    if (blocks.length === 0) return null;
    return {
      role: "user",
      content: blocks,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
    };
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
    if (blocks.length === 0 && !m.errorMessage) return null;
    return {
      role: "assistant",
      content: blocks,
      errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      completedAt: completedAtBySource.get(m),
    };
  }

  // custom/other messages: show when there is text
  const text = textFromContent(m.content);
  if (!text) return null;
  return {
    role: "custom",
    content: [{ type: "text", text }],
    timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
  };
}

/**
 * Convert pi's AgentMessage[] to UI messages.
 * toolResult messages are paired and merged into their toolCall block.
 *
 * Unchanged messages are returned as the *same object reference* across calls.
 * Snapshots are broadcast on every message_end / tool_execution_end, so without
 * this the server would rebuild (and re-strip ANSI from) the entire conversation
 * dozens of times per agent turn, and no client-side memo could ever hit.
 */
export function serializeMessages(messages: unknown[]): UIMessage[] {
  const msgs = messages as AnyMessage[];

  // toolCallId -> result mapping
  const results = new Map<string, SerializedResult>();
  for (const m of msgs) {
    if (m.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    let result = resultBySource.get(m);
    if (!result) {
      result = serializeResult(m);
      resultBySource.set(m, result);
    }
    results.set(m.toolCallId, result);
  }

  const out: UIMessage[] = [];
  for (const m of msgs) {
    if (m.role === "toolResult") continue; // merged into toolCall

    const messageResults = resultsForMessage(m, results);
    const cached = uiBySource.get(m);
    if (cached && sameResults(cached.results, messageResults)) {
      if (cached.ui) out.push(cached.ui);
      continue;
    }

    const ui = serializeMessage(m, results);
    uiBySource.set(m, { results: messageResults, ui });
    if (ui) out.push(ui);
  }

  return out;
}

function latestTodoTasks(messages: UIMessage[]): UITodoTask[] | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant") continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block?.type === "toolCall" && block.name === "todo" && block.result?.tasks?.length) {
        return block.result.tasks;
      }
    }
  }
  return undefined;
}

/**
 * Derive the next active task at tool start, before the todo result snapshot is
 * available. Only an explicit transition to in_progress is optimistic; all
 * other mutations wait for the authoritative details.tasks result.
 */
export function getOptimisticActiveTodo(
  messages: UIMessage[],
  args: unknown,
): UIActiveTodo | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as { action?: unknown; id?: unknown; status?: unknown; activeForm?: unknown };
  if (input.action !== "update" || input.status !== "in_progress" || typeof input.id !== "number") {
    return undefined;
  }

  const tasks = latestTodoTasks(messages);
  const current = tasks?.findIndex((task) => task.id === input.id) ?? -1;
  const task = current >= 0 ? tasks?.[current] : undefined;
  if (!task || !tasks) return undefined;
  return {
    subject: task.subject,
    activeForm:
      typeof input.activeForm === "string" && input.activeForm.trim()
        ? input.activeForm
        : task.activeForm,
    status: "in_progress",
    current: current + 1,
    total: tasks.length,
  };
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
