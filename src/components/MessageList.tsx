import { useEffect, useMemo, useRef, useState } from "react";
import type { UIContentBlock, UIMessage } from "../../shared/protocol";
import type { ActiveTool } from "../lib/chat";
import { buildEditDiffFromArgs, isUnifiedDiff } from "../lib/diff";
import { useT } from "../lib/i18n";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

function ToolCallCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  const args = block.args ? JSON.stringify(block.args) : "";
  // edit 도구: 인자(path/edits 또는 legacy file/oldText/newText)를 git diff 스타일로 렌더
  const edit = block.name === "edit" ? buildEditDiffFromArgs(block.args) : null;
  // edit 실행 결과에 실제 diff(details.diff)가 있으면 그것을 우선 표시
  const resultDiff = block.result?.diff;
  const resultIsDiff = !!resultDiff || (!!block.result && isUnifiedDiff(block.result.text));
  const resultText = block.result?.text ?? "";

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
        {edit ? (
          <span className="truncate font-mono text-xs text-faint">{edit.path}</span>
        ) : (
          <span className="truncate font-mono text-xs text-faint">{args.slice(0, 80)}</span>
        )}
      </summary>
      <div className="border-t border-line px-3 py-2">
        {edit ? (
          <DiffView text={edit.diff} maxHeight="max-h-64" />
        ) : (
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">
            {args}
          </pre>
        )}
        {block.result && (
          <div
            className={`mt-2 ${edit || resultIsDiff ? "" : "border-t border-line pt-2"}`}
          >
            {resultDiff ? (
              <DiffView text={resultDiff.slice(0, 12_000)} maxHeight="max-h-64" />
            ) : resultIsDiff ? (
              <DiffView text={resultText.slice(0, 12_000)} maxHeight="max-h-64" />
            ) : (
              <pre
                className={`max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap ${
                  block.result.isError ? "text-red-500 dark:text-red-400" : "text-ink"
                }`}
              >
                {resultText.slice(0, 4000) || "(no output)"}
              </pre>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <details className="my-1.5 text-sm">
      <summary className="cursor-pointer text-xs text-faint select-none">thinking…</summary>
      <div className="mt-1 min-w-0 break-words border-l-2 border-line pl-3 text-muted italic whitespace-pre-wrap">
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

function Message({ message, index }: { message: UIMessage; index?: number }) {
  if (message.role === "user") {
    return (
      <div
        className="flex min-w-0 justify-end scroll-mt-4"
        data-msg-index={index}
      >
        <div className="user-bubble min-w-0 max-w-[85%] break-words rounded-2xl bg-bubble px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ink sm:max-w-[75%]">
          <Blocks blocks={message.content} markdown={false} />
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 text-[15px]">
      <Blocks blocks={message.content} markdown />
      {message.errorMessage && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
          {message.errorMessage}
        </div>
      )}
    </div>
  );
}

/**
 * 사용자 메시지 앵커 내비게이션 (모바일 우선):
 * 오른쪽 중앙 부동 버튼 → 하단 시트에서 사용자 메시지 목록 → 탭하면 해당 위치로 스크롤 + 하이라이트.
 */
function MessageAnchors({
  messages,
  containerRef,
}: {
  messages: UIMessage[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const userIndices = useMemo(() => {
    const idx: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user") idx.push(i);
    });
    return idx;
  }, [messages]);

  if (userIndices.length < 2) return null;

  const jump = (i: number) => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-msg-index="${i}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      const bubble = el.querySelector<HTMLElement>(".user-bubble");
      const target = bubble ?? el;
      target.classList.remove("anchor-flash");
      void target.offsetWidth; // 리플로우 → 애니메이션 재시작
      target.classList.add("anchor-flash");
    }
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("messageAnchors")}
        title={t("messageAnchors")}
        className="absolute top-1/2 right-2 z-10 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-card/90 text-muted shadow-sm backdrop-blur transition-colors hover:bg-hover hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
          <path
            d="M4 6h16M4 12h16M4 18h10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center md:items-center"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative z-10 flex max-h-[65vh] w-full flex-col rounded-t-2xl bg-card shadow-2xl outline-none md:max-w-sm md:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("messageAnchors")}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
              <span className="text-sm font-medium text-ink">{t("messageAnchors")}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("cancel")}
                className="flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                  <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="thin-scroll overflow-y-auto py-1">
              {userIndices.map((i, n) => {
                const m = messages[i]!;
                const text =
                  m.content
                    .filter((b): b is { type: "text"; text: string } => b.type === "text")
                    .map((b) => b.text)
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim() || t("emptyMessage");
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => jump(i)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-[11px] text-muted tabular-nums">
                      {n + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
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
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={containerRef}
        onScroll={() => {
          const el = containerRef.current;
          if (!el) return;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="thin-scroll h-full overflow-x-hidden overflow-y-auto"
      >
        <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && !streamText && (
            <div className="mt-28 text-center">
              <div className="text-4xl text-accent">π</div>
              <div className="mt-3 text-[15px] text-faint">{t("emptyPrompt")}</div>
            </div>
          )}
          {messages.map((m, i) => (
            <Message key={i} message={m} index={m.role === "user" ? i : undefined} />
          ))}
          {streamThinking && <Thinking text={streamThinking} />}
          {streamText && (
            <div className="min-w-0 text-[15px]">
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
      <MessageAnchors messages={messages} containerRef={containerRef} />
    </div>
  );
}
