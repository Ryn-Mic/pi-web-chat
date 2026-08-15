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
