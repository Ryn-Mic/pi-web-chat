import { memo, type CSSProperties, useEffect, useRef, useState } from "react";
import type { UIContentBlock, UIMessage } from "../../shared/protocol";
import { chatClient, type ActiveTool } from "../lib/chat";
import { chatFontSizePixels, useChatFontSize } from "../lib/chatFontSize";
import { buildEditDiffFromArgs, isUnifiedDiff } from "../lib/diff";
import { useT } from "../lib/i18n";
import { DiffView } from "./DiffView";
import { Markdown, streamdownPlugins } from "./Markdown";
import { Streamdown } from "streamdown";

/** todo 工具: 状态 → 표시 색/심볼 */
function TodoStatusIcon({ status }: { status: string }) {
  if (status === "completed") {
    return <span className="text-emerald-500">✓</span>;
  }
  if (status === "in_progress") {
    return <span className="text-amber-500">▶</span>;
  }
  return <span className="text-faint">○</span>;
}

/** todo 工具 카드: 진행률 바 + 작업 목록 */
function TodoCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  const t = useT();
  const tasks = block.result?.tasks ?? [];
  const done = tasks.filter((x) => x.status === "completed").length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  const current = tasks.find((x) => x.status === "in_progress");
  const summary = tasks.length > 0
    ? `${done}/${tasks.length}${current?.activeForm ? ` · ${current.activeForm}` : ""}`
    : t("toolRunning", { name: "todo" });
  return (
    <details className="my-2 rounded-xl border border-line bg-card/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            block.result?.isError ? "bg-red-500" : "bg-emerald-500/80"
          }`}
        />
        <span className="font-medium text-ink">todo</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{summary}</span>
        {tasks.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">{pct}%</span>
        )}
      </summary>
      {tasks.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li key={task.id} className="flex min-w-0 items-center gap-2 text-[13px]">
                <span className="w-4 shrink-0 text-center">
                  <TodoStatusIcon status={task.status} />
                </span>
                <span
                  className={`min-w-0 truncate ${
                    task.status === "completed"
                      ? "text-faint line-through"
                      : task.status === "in_progress"
                        ? "text-ink"
                        : "text-muted"
                  }`}
                >
                  {task.subject}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

/** ask_user_question 확장 카드: 질문 + 옵션을 읽기 전용으로 표시 */
function AskCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  const t = useT();
  const args =
    block.args && typeof block.args === "object"
      ? (block.args as { questions?: Array<{ question?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }> })
      : null;
  const questions = args?.questions ?? [];
  return (
    <details className="my-2 rounded-xl border border-line bg-card/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <span className="size-1.5 shrink-0 rounded-full bg-purple-500/80" />
        <span className="font-medium text-ink">ask_user_question</span>
        <span className="truncate font-mono text-xs text-muted">
          {questions.length > 0 ? `${questions.length} question(s)` : block.result?.text ?? ""}
        </span>
      </summary>
      {questions.length > 0 && (
        <div className="space-y-3 border-t border-line px-3 py-2">
          {questions.map((q, qi) => (
            <div key={qi}>
              <p className="font-medium text-ink">
                {q.multiSelect ? "[multi] " : ""}
                {q.question ?? ""}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(q.options ?? []).map((opt, oi) => (
                  <span
                    key={oi}
                    className="rounded-lg border border-line bg-bubble px-2 py-1 text-xs text-muted"
                    title={opt.description}
                  >
                    {opt.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-faint">
            {t("askAnswerInTerminal")}
          </p>
        </div>
      )}
    </details>
  );
}

function ToolCallCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  // todo tool: dedicated progress card (full task list via result.tasks)
  if (block.name === "todo") return <TodoCard block={block} />;
  // ask_user_question extension: read-only questionnaire card
  if (block.name === "ask_user_question") return <AskCard block={block} />;

  const args = block.args ? JSON.stringify(block.args) : "";
  // edit tool: render args (path/edits or legacy file/oldText/newText) as a git diff
  const edit = block.name === "edit" ? buildEditDiffFromArgs(block.args) : null;
  // bash tool: collapsed state shows the actual command + timeout, not raw JSON
  const bash =
    block.name === "bash" && block.args && typeof block.args === "object"
      ? (block.args as { command?: unknown; timeout?: unknown })
      : null;
  // read tool: collapsed state shows which file is being read
  const read =
    block.name === "read" && block.args && typeof block.args === "object"
      ? (block.args as { path?: unknown })
      : null;
  const command = bash && typeof bash.command === "string" ? bash.command : null;
  const readPath = read && typeof read.path === "string" ? read.path : null;
  const timeout =
    bash && typeof bash.timeout === "number" && bash.timeout > 0 ? bash.timeout : null;
  const summary = command != null ? `$ ${command}` : readPath != null ? `read ${readPath}` : null;
  // Expanded body for bash/read: the meaningful arg, not the full JSON blob
  const detailText =
    command != null ? `$ ${command}` : readPath != null ? `read ${readPath}` : null;
  // The edit request already produces the complete diff. pi repeats that
  // payload as result.diff after success, so rendering both produces two
  // identical panels for one file change.
  const resultDiff = block.result?.diff;
  const resultIsDiff = !!resultDiff || (!!block.result && isUnifiedDiff(block.result.text));
  const resultText = block.result?.text ?? "";
  const showResult = Boolean(block.result) && !(edit && resultIsDiff && !block.result?.isError);

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
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-faint">
              {edit.path}
            </span>
            {edit.stats && (edit.stats.added > 0 || edit.stats.deleted > 0) && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{edit.stats.added}</span>{" "}
                <span className="text-red-500">−{edit.stats.deleted}</span>
              </span>
            )}
          </span>
        ) : summary ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="fade-x min-w-0 flex-1 truncate font-mono text-xs text-muted">
              {summary}
            </span>
            {timeout != null && (
              <span className="shrink-0 font-mono text-[10px] text-faint">⏱ {timeout}s</span>
            )}
          </span>
        ) : (
          <span className="truncate font-mono text-xs text-faint">{args.slice(0, 80)}</span>
        )}
      </summary>
      <div className="border-t border-line px-3 py-2">
        {edit ? (
          <DiffView text={edit.diff} maxHeight="max-h-64" />
        ) : detailText ? (
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-ink">
            {detailText}
          </pre>
        ) : (
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">
            {args}
          </pre>
        )}
        {showResult && block.result && (
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

function Thinking({
  text,
  defaultOpen = true,
  streaming = false,
  collapsed = false,
}: {
  text: string;
  defaultOpen?: boolean;
  streaming?: boolean;
  /** The agent has sent its explicit thinking_end event. */
  collapsed?: boolean;
}) {
  // Streaming thinking is expanded by default; snapshot thinking blocks are
  // collapsed by default (defaultOpen=false). Users can toggle manually.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={collapsed ? false : open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="chat-message-text my-1.5"
    >
      <summary className="cursor-pointer text-xs text-faint select-none">thinking…</summary>
      <div className="mt-1 min-w-0 break-words border-l-2 border-line pl-3 text-muted italic [&_pre]:not-italic [&_code]:not-italic">
        {/* Thinking renders markdown too (bold/code/emphasis); Streamdown
            handles incomplete syntax while streaming. */}
        <Streamdown mode={streaming ? "streaming" : "static"} plugins={streamdownPlugins}>
          {text}
        </Streamdown>
      </div>
    </details>
  );
}

function Blocks({
  blocks,
  markdown,
}: {
  blocks: UIContentBlock[];
  markdown: boolean;
}) {
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
            return <Thinking key={i} text={b.text} defaultOpen={false} />;
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

function copyableText(blocks: UIContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<UIContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* Clipboard permissions are controlled by the browser. */
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="flex size-7 items-center justify-center rounded-md border border-line bg-card text-faint shadow-sm transition-colors hover:bg-hover hover:text-ink"
      aria-label={copied ? t("copied") : t("copyMessage")}
      title={copied ? t("copied") : t("copyMessage")}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2" aria-hidden>
          <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2" aria-hidden>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      )}
    </button>
  );
}

/** 重新填充: 把这条消息的文本填回输入框 (corner-up-left icon) */
function ReuseButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md border border-line bg-card text-faint shadow-sm transition-colors hover:bg-hover hover:text-ink"
      aria-label={t("reuseMessage")}
      title={t("reuseMessage")}
    >
      <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2" aria-hidden>
        <path d="M9 14 4 9l5-5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** 消息操作按钮行: 从左侧开始排 (copy + optional reuse) */
function MessageActions({ text, onReuse }: { text: string; onReuse?: () => void }) {
  return (
    <div className="mt-1 flex justify-start gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-within:opacity-100">
      <CopyButton text={text} />
      {onReuse && <ReuseButton onClick={onReuse} />}
    </div>
  );
}

const Message = memo(function Message({
  message,
  index,
  isRoundSummary,
}: {
  message: UIMessage;
  index?: number;
  /** 本轮任务的总结消息 (最后一条 assistant 消息) — 展示复制按钮 */
  isRoundSummary: boolean;
}) {
  const text = copyableText(message.content);
  if (message.role === "user") {
    return (
      <div
        className="group/message flex min-w-0 scroll-mt-4 flex-col items-end"
        data-msg-index={index}
      >
        <div className="user-bubble relative min-w-0 max-w-[85%] break-words rounded-2xl bg-bubble px-4 py-2.5 whitespace-pre-wrap text-ink sm:max-w-[75%]">
          <div className="chat-message-text"><Blocks blocks={message.content} markdown={false} /></div>
        </div>
        {text && (
          <MessageActions
            text={text}
            onReuse={() => chatClient.refillComposer(text)}
          />
        )}
      </div>
    );
  }
  return (
    <div className="group/message min-w-0">
      <div className="chat-message-text min-w-0"><Blocks blocks={message.content} markdown /></div>
      {message.errorMessage && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
          {message.errorMessage}
        </div>
      )}
      {isRoundSummary && text && (
        <MessageActions text={text} />
      )}
    </div>
  );
});
export function MessageList({
  messages,
  streamText,
  streamThinking,
  streamThinkingComplete,
  activeTools,
  isStreaming,
  containerRef,
}: {
  messages: UIMessage[];
  streamText: string;
  streamThinking: string;
  streamThinkingComplete: boolean;
  activeTools: ActiveTool[];
  isStreaming: boolean;
  /** Scroll container (owned externally for message-anchor jumps) */
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const chatFontSize = useChatFontSize();
  // 一轮任务以 user 消息为界; 每个 user 消息后的最后一条 assistant 消息就是该轮总结
  const isRoundSummary = (i: number): boolean => {
    const m = messages[i];
    if (!m || m.role !== "assistant") return false;
    const next = messages[i + 1];
    return next === undefined || next.role === "user";
  };
  const stickToBottom = useRef(true);
  const chatStyle = {
    "--chat-font-size": `${chatFontSizePixels(chatFontSize)}px`,
  } as CSSProperties;

  // Scroll to bottom on new content. rAF-coalesced and gated on the user
  // already being at the bottom — the old bare scrollIntoView ran on every
  // render (per stream delta) and forced synchronous layout.
  useEffect(() => {
      if (!stickToBottom.current) return;
      const container = containerRef.current;
      if (!container) return;
      const raf = requestAnimationFrame(() => {
        if (!stickToBottom.current) return;
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distance > 1) container.scrollTop = container.scrollHeight;
      });
    return () => cancelAnimationFrame(raf);
  }, [messages, streamText, streamThinking, activeTools, isStreaming, containerRef]);

  // Only show ... while waiting for a response (hidden when final assistant
  // text exists → no ghost dots after the stream ends)
  const last = messages[messages.length - 1];
  const waitingForAssistant =
    !last ||
    last.role === "user" ||
    (last.role === "assistant" && last.content.some((b) => b.type === "toolCall" && b.result));
  const showTyping =
    isStreaming && !streamText && !streamThinking && activeTools.length === 0 && waitingForAssistant;

  return (
    <div className="message-list relative min-h-0 min-w-0 flex-1" style={chatStyle}>
      <div
        ref={containerRef}
        onScroll={() => {
          const el = containerRef.current;
          if (!el) return;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="thin-scroll h-full overflow-x-hidden overflow-y-auto"
      >
        <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-4 px-3 py-4 sm:gap-5 sm:px-4 sm:py-5">
          {messages.length === 0 && !streamText && (
            <div className="mt-28 text-center">
              <div className="text-4xl text-accent">π</div>
              <div className="mt-3 text-[15px] text-faint">{t("emptyPrompt")}</div>
            </div>
          )}
          {messages.map((m, i) => (
            <Message
              key={i}
              message={m}
              index={m.role === "user" ? i : undefined}
              isRoundSummary={isRoundSummary(i)}
            />
          ))}
          {streamThinking && (
            <Thinking
              text={streamThinking}
              streaming
              collapsed={streamThinkingComplete}
            />
          )}
          {streamText && (
            <div className="chat-message-text min-w-0">
              {/* Streamdown handles incomplete markdown natively — no manual escaping */}
              <Markdown text={streamText} streaming />
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
    </div>
  );
}
