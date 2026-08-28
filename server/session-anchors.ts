import type { UIMessageAnchor } from "../shared/protocol.ts";

const MAX_PREVIEW_CHARS = 240;

function collapsedUserText(message: { content?: unknown }): string {
  const content = message.content;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is { type?: string; text: string } =>
                !!block &&
                typeof block === "object" &&
                "text" in block &&
                typeof block.text === "string" &&
                (!('type' in block) || block.type === "text"),
            )
            .map((block) => block.text)
            .join(" ")
        : "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_PREVIEW_CHARS
    ? `${collapsed.slice(0, MAX_PREVIEW_CHARS - 1).trimEnd()}…`
    : collapsed;
}

function timestampMs(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Keep anchor ordinals aligned with user messages that serialize into the UI. */
function hasRenderableUserContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (("type" in block && block.type === "image") ||
        ("type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string" &&
          block.text.length > 0)),
  );
}

/** Build a small index from an already resolved active session branch. */
export function createSessionUserMessageAnchors(entries: readonly unknown[]): UIMessageAnchor[] {
  const anchors: UIMessageAnchor[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
      message?: unknown;
    };
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
      continue;
    }
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" || !hasRenderableUserContent(message.content)) continue;

    const ordinal = anchors.length + 1;
    anchors.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `user-${ordinal}`,
      ordinal,
      text: collapsedUserText(message),
      timestamp: timestampMs(entry.timestamp),
    });
  }
  return anchors;
}

export interface CodexThreadItemsPage {
  data: readonly unknown[];
  nextCursor: string | null;
}

function codexUserMessageContent(item: { content?: unknown }): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(item.content)) return [];
  const blocks: Array<{ type: "text"; text: string }> = [];
  for (const value of item.content) {
    if (!value || typeof value !== "object") continue;
    const part = value as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "mention") {
      const text = typeof part.name === "string"
        ? part.name
        : typeof part.path === "string"
          ? part.path
          : "";
      if (text) blocks.push({ type: "text", text });
    } else if (part.type === "skill" && typeof part.name === "string" && part.name) {
      blocks.push({ type: "text", text: part.name });
    } else if (part.type === "localImage" && typeof part.path === "string") {
      blocks.push({ type: "text", text: `[Image: ${part.path}]` });
    } else if (part.type === "image" && typeof part.url === "string") {
      blocks.push({ type: "text", text: `[Image: ${part.url}]` });
    }
  }
  return blocks;
}

/**
 * Scan Codex's native item index in chronological pages. This keeps anchor
 * ordinals global without hydrating every turn (and its tool output) into the
 * Web session just to locate user messages.
 */
export async function createCodexUserMessageAnchors(
  loadPage: (cursor: string | null) => Promise<CodexThreadItemsPage>,
): Promise<UIMessageAnchor[]> {
  const anchors: UIMessageAnchor[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await loadPage(cursor);
    for (const value of page.data) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { item?: unknown };
      if (!entry.item || typeof entry.item !== "object") continue;
      const item = entry.item as { id?: unknown; type?: unknown; content?: unknown };
      if (item.type !== "userMessage") continue;
      const content = codexUserMessageContent(item);
      if (content.length === 0) continue;
      const ordinal = anchors.length + 1;
      anchors.push({
        id: typeof item.id === "string" && item.id ? item.id : `codex-user-${ordinal}`,
        ordinal,
        text: collapsedUserText({ content }),
      });
    }

    const nextCursor = typeof page.nextCursor === "string" && page.nextCursor
      ? page.nextCursor
      : null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error("Codex item pagination returned a repeated cursor");
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return anchors;
}
