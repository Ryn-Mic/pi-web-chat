import { useEffect, useRef } from "react";
import type { UIContentBlock, UIMessage } from "../../shared/protocol";
import type { ActiveTool } from "../lib/chat";
import { useT } from "../lib/i18n";
import { Markdown } from "./Markdown";

function ToolCallCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  const args = block.args ? JSON.stringify(block.args) : "";
  return (
    <details className="my-2 rounded-xl border border-line bg-card/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            block.result
              ? block.result.isError
                ? "bg-red-500"
                : "bg-emerald-500/80"
              : "bg-amber-400 animate-pulse"
          }`}
        />
        <span className="font-medium text-ink">{block.name}</span>
        <span className="truncate font-mono text-xs text-faint">{args.slice(0, 80)}</span>
      </summary>
      <div className="border-t border-line px-3 py-2">
        <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">
          {args}
        </pre>
        {block.result && (
          <pre
            className={`mt-2 max-h-64 overflow-auto border-t border-line pt-2 font-mono text-xs whitespace-pre-wrap ${
              block.result.isError ? "text-red-500 dark:text-red-400" : "text-ink"
            }`}
          >
            {block.result.text.slice(0, 4000) || "(no output)"}
          </pre>
        )}
      </div>
    </details>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <details className="my-1.5 text-sm">
      <summary className="cursor-pointer text-xs text-faint select-none">thinking…</summary>
      <div className="mt-1 border-l-2 border-line pl-3 text-muted italic whitespace-pre-wrap">
        {text}
      </div>
    </details>
  );
}

function Blocks({ blocks, markdown }: { blocks: UIContentBlock[]; markdown: boolean }) {
  const t = useT();
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return markdown ? (
              <Markdown key={i} text={b.text} />
            ) : (
              <div key={i} className="whitespace-pre-wrap leading-relaxed">
                {b.text}
              </div>
            );
          case "thinking":
            return <Thinking key={i} text={b.text} />;
          case "toolCall":
            return <ToolCallCard key={i} block={b} />;
          case "image":
            return b.dataUrl ? (
              <img
                key={i}
                src={b.dataUrl}
                alt={t("attachedImage")}
                className="my-1 max-h-64 max-w-full rounded-lg"
              />
            ) : (
              <div key={i} className="text-xs opacity-60">
                {t("imagePlaceholder")}
              </div>
            );
        }
      })}
    </>
  );
}

function Message({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-bubble px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ink sm:max-w-[75%]">
          <Blocks blocks={message.content} markdown={false} />
        </div>
      </div>
    );
  }
  return (
    <div className="text-[15px]">
      <Blocks blocks={message.content} markdown />
      {message.errorMessage && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
          {message.errorMessage}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streamText,
  streamThinking,
  activeTools,
  isStreaming,
}: {
  messages: UIMessage[];
  streamText: string;
  streamThinking: string;
  activeTools: ActiveTool[];
  isStreaming: boolean;
}) {
  const t = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
    }
  });

  // 응답 대기 중일 때만 ... 표시 (최종 assistant 텍스트가 있으면 숨김 → 종료 후 잔상 방지)
  const last = messages[messages.length - 1];
  const waitingForAssistant =
    !last ||
    last.role === "user" ||
    (last.role === "assistant" && last.content.some((b) => b.type === "toolCall" && b.result));
  const showTyping =
    isStreaming && !streamText && !streamThinking && activeTools.length === 0 && waitingForAssistant;

  return (
    <div
      ref={containerRef}
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="thin-scroll min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
        {messages.length === 0 && !streamText && (
          <div className="mt-28 text-center">
            <div className="text-4xl text-accent">π</div>
            <div className="mt-3 text-[15px] text-faint">{t("emptyPrompt")}</div>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
        {streamThinking && <Thinking text={streamThinking} />}
        {streamText && (
          <div className="text-[15px]">
            <Markdown text={streamText} />
          </div>
        )}
        {activeTools.map((tool) => (
          <div key={tool.toolCallId} className="flex items-center gap-2 text-sm text-muted">
            <span className="size-2 animate-pulse rounded-full bg-amber-400" />
            {t("toolRunning", { name: tool.toolName })}
          </div>
        ))}
        {showTyping && (
          <div className="flex items-center gap-1.5 text-faint">
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
