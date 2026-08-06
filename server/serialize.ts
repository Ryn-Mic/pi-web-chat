import type { UIContentBlock, UIMessage } from "../shared/protocol.ts";

type AnyMessage = {
  role: string;
  content?: unknown;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};

/** ANSI 이스케이프 시퀀스 제거 (pi-claude-code-ui 등 확장이 남긴 색상/스타일 코드) */
function stripAnsi(text: string): string {
  // SGR/커서 제어: ESC [ ...  (종료 문자 a-zA-Z 또는 @~)
  let out = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // OSC (예: ESC ] ... BEL)
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
 * pi의 AgentMessage[] 를 UI용 메시지로 변환.
 * toolResult 메시지는 해당 toolCall 블록에 페어링해서 합친다.
 */
export function serializeMessages(messages: unknown[]): UIMessage[] {
  const msgs = messages as AnyMessage[];

  // toolCallId -> result 매핑
  const results = new Map<string, { text: string; isError: boolean; diff?: string }>();
  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const details =
        m.details && typeof m.details === "object"
          ? (m.details as Record<string, unknown>)
          : null;
      const diff = details && typeof details.diff === "string" ? details.diff : undefined;
      results.set(m.toolCallId, {
        text: textFromContent(m.content),
        isError: m.isError === true,
        ...(diff ? { diff } : {}),
      });
    }
  }

  const out: UIMessage[] = [];
  for (const m of msgs) {
    if (m.role === "toolResult") continue; // toolCall에 합쳐짐

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
      if (blocks.length > 0) out.push({ role: "user", content: blocks });
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
        });
      }
      continue;
    }

    // custom/기타 메시지: 텍스트가 있으면 표시
    const text = textFromContent(m.content);
    if (text) out.push({ role: "custom", content: [{ type: "text", text }] });
  }

  return out;
}
