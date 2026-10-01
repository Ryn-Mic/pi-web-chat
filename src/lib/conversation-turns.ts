import type { UIMessage } from "../../shared/protocol";
import { messageKeys } from "./message-identity";
import { splitAssistantTurnCompletion } from "./turn-completion";

export interface TurnMessage {
  key: string;
  index: number;
  message: UIMessage;
}

export interface ConversationTurn {
  key: string;
  prompt?: TurnMessage;
  process: TurnMessage[];
  reply?: TurnMessage;
  noticesBefore: TurnMessage[];
  noticesAfter: TurnMessage[];
  active: boolean;
  /** Failed, unresolved or no-final turns must not disappear automatically. */
  collapsible: boolean;
}

/** Group only the loaded page; never inspect or reparse the persisted transcript. */
export function conversationTurns(messages: UIMessage[], isStreaming: boolean): ConversationTurn[] {
  const keys = messageKeys(messages);
  const groups: Array<{ prompt?: TurnMessage; entries: TurnMessage[] }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const entry = { key: keys[index]!, index, message: messages[index]! };
    if (entry.message.role === "user") {
      groups.push({ prompt: entry, entries: [] });
    } else {
      if (!groups.length) groups.push({ entries: [] });
      groups[groups.length - 1]!.entries.push(entry);
    }
  }

  return groups.map((group, groupIndex) => {
    const active = isStreaming && groupIndex === groups.length - 1;
    const assistants = group.entries.filter((entry) => entry.message.role === "assistant");
    const last = assistants.at(-1);
    let reply: TurnMessage | undefined;
    const process = assistants.slice();
    if (!active && last && !last.message.errorMessage) {
      const content = splitAssistantTurnCompletion(last.message.content)?.content ?? last.message.content;
      const lastTool = content.findLastIndex((block) => block.type === "toolCall");
      const replyBlocks = content.filter((block, index) => index > lastTool && block.type !== "thinking");
      if (replyBlocks.some((block) => block.type === "text" && block.text.trim())) {
        // Keep the original final message's duration metadata for its existing footer.
        const originalLastTool = last.message.content.findLastIndex((block) => block.type === "toolCall");
        const replyContent = last.message.content.filter(
          (block, index) => index > originalLastTool && block.type !== "thinking",
        );
        reply = { ...last, message: replyContent.length === last.message.content.length
          ? last.message
          : { ...last.message, content: replyContent } };
        const processBlocks = content.filter((block, index) => index <= lastTool || block.type === "thinking");
        process.pop();
        if (processBlocks.length) process.push({ ...last, message: { ...last.message, content: processBlocks } });
      }
    }
    const unsafe = assistants.some(({ message }) => message.errorMessage || message.content.some(
      (block) => block.type === "toolCall" && (!block.result || block.result.isError),
    ));
    const notices = group.entries.filter((entry) => entry.message.role === "custom");
    return {
      // A final reply also anchors a page that begins mid-turn, even after its prompt is prepended.
      key: `turn:${reply?.key ?? group.prompt?.key ?? group.entries[0]!.key}`,
      prompt: group.prompt,
      process,
      reply,
      noticesBefore: notices.filter((entry) => !reply || entry.index < reply.index),
      noticesAfter: notices.filter((entry) => reply && entry.index > reply.index),
      active,
      collapsible: !!reply && !unsafe,
    };
  });
}
