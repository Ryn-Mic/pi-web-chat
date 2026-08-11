import { useEffect, useRef, type TouchEvent, type WheelEvent } from "react";
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
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * 바닥 고정 모드: 스트리밍 중 내용이 자라면 바닥을 따라간다.
   * 사용자가 위로 올리면 해제되고, 다시 바닥 근처로 내려오면 복귀한다.
   *
   * onScroll만으로 판단하면 경합이 생긴다: scroll 이벤트는 프레임 단위로
   * 비동기 dispatch되므로, 사용자가 위로 스크롤한 직후 delta 렌더가
   * 끼어들면 stickToBottom이 아직 true여서 화면이 아래로 강제 당겨진다
   * (스트리밍 중 "위로 못 올라감" 증상). wheel/touch는 스크롤보다 먼저
   * 동기로 도착하므로 여기서 즉시 해제해 경합을 없앤다.
   */
  const stickToBottom = useRef(true);
  const touchStartY = useRef<number | null>(null);

  // 바닥 고정 중이면 컨테이너를 직접 바닥으로 스크롤한다.
  // scrollIntoView는 조상 스크롤러까지 건드릴 수 있어 비결정적이다.
  useEffect(() => {
    const el = containerRef.current;
    if (stickToBottom.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) stickToBottom.current = false; // 위로 올리려는 시도
  };

  const handleTouchStart = (e: TouchEvent) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (touchStartY.current === null) return;
    const y = e.touches[0]?.clientY;
    if (y != null && y > touchStartY.current + 4) {
      stickToBottom.current = false; // 손가락 아래로 = 내용이 위로
    }
  };

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
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
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
      </div>
    </div>
  );
}
