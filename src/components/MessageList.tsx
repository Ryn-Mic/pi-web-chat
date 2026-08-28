import { memo, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { UIAgentKind, UIContentBlock, UIMessage } from "../../shared/protocol";
import { chatClient, type ActiveTool } from "../lib/chat";
import { chatFontSizePixels, useChatFontSize } from "../lib/chatFontSize";
import { buildEditDiffFromArgs, isUnifiedDiff } from "../lib/diff";
import { useT } from "../lib/i18n";
import { sameToolCallBlock, todoCallSummary, type ToolCallBlock } from "../lib/toolCall";
import {
  formatTurnCompletedAt,
  isAssistantTurnComplete,
  splitAssistantTurnCompletion,
} from "../lib/turn-completion";
import { LoadingIndicator } from "./LoadingIndicator";
import { AgentEyes } from "./AgentEyes";
import { AgentIcon } from "./AgentIcon";
import { DiffView } from "./DiffView";
import { CopyActionIcon } from "./MorphIcons";
import {
  Markdown,
  PlainTextFileLinks,
  streamdownPlugins,
  type PreviewMessageFile,
} from "./Markdown";
import { Streamdown } from "streamdown";

/** todo 工具: 状态 → 표시 색/심볼 */
function TodoStatusIcon({ status }: { status: string }) {
  if (status === "completed") {
    return <AgentEyes state="happy" size={12} className="text-emerald-500" animated={false} />;
  }
  if (status === "in_progress") {
    return <AgentEyes state="working" size={12} className="text-amber-500" animated={false} />;
  }
  return <AgentEyes state="idle" size={12} className="text-sky-500/80 dark:text-sky-400/80" animated={false} />;
}

/** todo 工具 카드: 진행률 바 + 작업 목록 */
function TodoCard({ block }: { block: Extract<UIContentBlock, { type: "toolCall" }> }) {
  const t = useT();
  const tasks = block.result?.tasks ?? [];
  const done = tasks.filter((x) => x.status === "completed").length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  const current = tasks.find((x) => x.status === "in_progress");
  const summary =
    todoCallSummary(block) ??
    (tasks.length > 0
      ? `${done}/${tasks.length}${current?.activeForm ? ` · ${current.activeForm}` : ""}`
      : t("toolRunning", { name: "todo" }));
  return (
    <details className="my-2 rounded-xl border border-line bg-card/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <AgentEyes
          state={block.result?.isError ? "error" : block.result ? "happy" : "working"}
          size={14}
          animated={false}
          className={
            block.result?.isError ? "text-red-500" : block.result ? "text-emerald-500/90" : "text-amber-400"
          }
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
        <AgentEyes state="connecting" size={14} className="text-purple-500/80" animated={false} />
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

/**
 * Generic tool card (everything except todo / ask_user_question).
 *
 * Kept separate from {@link ToolCallCard} so the hooks below are never placed
 * after a conditional return. `block.args` keeps the agent's original object
 * reference across snapshots (see server/serialize.ts), so memoising on it is
 * effective even while the surrounding message objects are rebuilt.
 */
function GenericToolCard({ block }: { block: ToolCallBlock }) {
  const args = useMemo(() => (block.args ? JSON.stringify(block.args) : ""), [block.args]);
  // edit tool: render args (path/edits or legacy file/oldText/newText) as a git diff
  const edit = useMemo(
    () => (block.name === "edit" ? buildEditDiffFromArgs(block.args) : null),
    [block.name, block.args],
  );
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
  const resultText = block.result?.text ?? "";
  const hasResult = Boolean(block.result);
  const resultIsDiff = useMemo(
    () => !!resultDiff || (hasResult && isUnifiedDiff(resultText)),
    [resultDiff, hasResult, resultText],
  );
  const showResult = hasResult && !(edit && resultIsDiff && !block.result?.isError);

  return (
    <details className="my-2 rounded-xl border border-line bg-card/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <span
          className="flex shrink-0 items-center"
        >
          <AgentEyes
            state={
              block.result
                ? block.result.isError
                  ? "error"
                  : "happy"
                : "working"
            }
            size={14}
            animated={false}
            className={
              block.result
                ? block.result.isError
                  ? "text-red-500"
                  : "text-emerald-500/90"
                  : "text-amber-400"
            }
          />
        </span>
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

/**
 * Tool call card dispatcher.
 *
 * Memoised because every server snapshot rebuilds the message/block wrappers:
 * without this, each `tool_execution_end` re-renders (and re-computes the diff
 * of) every tool card in the whole conversation.
 */
const ToolCallCard = memo(
  function ToolCallCard({ block }: { block: ToolCallBlock }) {
    // todo tool: dedicated progress card (full task list via result.tasks)
    if (block.name === "todo") return <TodoCard block={block} />;
    // ask_user_question extension: read-only questionnaire card
    if (block.name === "ask_user_question") return <AskCard block={block} />;
    return <GenericToolCard block={block} />;
  },
  (prev, next) => sameToolCallBlock(prev.block, next.block),
);

function activeToolSummary(tool: ActiveTool): string {
  if (!tool.args || typeof tool.args !== "object") return "";
  const args = tool.args as Record<string, unknown>;
  const candidate = args.command ?? args.path ?? args.query ?? args.name;
  if (typeof candidate === "string") {
    return tool.toolName === "command" || tool.toolName === "bash"
      ? `$ ${candidate}`
      : candidate;
  }
  return "";
}

/** Live app-server item with reconnect-safe arguments and incremental output. */
function ActiveToolCard({ tool }: { tool: ActiveTool }) {
  const t = useT();
  const summary = activeToolSummary(tool);
  const args = useMemo(() => {
    if (tool.args === undefined) return "";
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {
      return String(tool.args);
    }
  }, [tool.args]);
  const output = tool.output?.slice(-12_000) ?? "";
  return (
    <details open className="rounded-xl border border-line bg-card/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <AgentEyes state="working" size={14} className="text-amber-400" />
        <span className="font-medium text-ink">{tool.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
          {summary || t("toolRunning", { name: tool.toolName })}
        </span>
      </summary>
      {(args || output) && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {args && !summary && (
            <pre className="thin-scroll max-h-32 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">
              {args}
            </pre>
          )}
          {output && (
            <pre
              aria-live="polite"
              className="thin-scroll max-h-56 overflow-auto rounded-lg bg-canvas px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink"
            >
              {output}
            </pre>
          )}
        </div>
      )}
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
            handles incomplete syntax while streaming. The Shiki plugin is
            withheld while streaming so growing fences are not re-tokenised on
            every flush (see Markdown.tsx). */}
        <Streamdown
          mode={streaming ? "streaming" : "static"}
          plugins={streaming ? undefined : streamdownPlugins}
        >
          {text}
        </Streamdown>
      </div>
    </details>
  );
}

function Blocks({
  blocks,
  markdown,
  cwd,
  onPreviewFile,
}: {
  blocks: UIContentBlock[];
  markdown: boolean;
  cwd?: string;
  onPreviewFile?: PreviewMessageFile;
}) {
  const t = useT();
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return markdown ? (
              <Markdown
                key={i}
                text={b.text}
                cwd={cwd}
                onPreviewFile={onPreviewFile}
              />
            ) : (
              <div key={i} className="whitespace-pre-wrap leading-relaxed">
                <PlainTextFileLinks text={b.text} cwd={cwd} onPreviewFile={onPreviewFile} />
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
      <CopyActionIcon copied={copied} size={14} />
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

function AssistantTurnFooter({
  text,
  summary,
  completedAt,
}: {
  text: string;
  summary?: string;
  completedAt?: number;
}) {
  const completedLabel =
    typeof completedAt === "number" ? formatTurnCompletedAt(completedAt) : "";
  const completedDateTime =
    completedLabel && typeof completedAt === "number"
      ? new Date(completedAt).toISOString()
      : undefined;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-xs text-faint">
      <div className="shrink-0">
        <CopyButton text={text} />
      </div>
      {summary && (
        <span className="min-w-0 truncate" title={summary}>
          {summary}
        </span>
      )}
      {completedLabel && completedDateTime && (
        <time
          className="ml-auto shrink-0 font-mono text-[11px] tabular-nums"
          dateTime={completedDateTime}
        >
          {completedLabel}
        </time>
      )}
    </div>
  );
}

const Message = memo(function Message({
  message,
  index,
  isTurnComplete,
  cwd,
  onPreviewFile,
}: {
  message: UIMessage;
  index?: number;
  /** Only a settled turn shows assistant completion metadata and copy. */
  isTurnComplete: boolean;
  cwd?: string;
  onPreviewFile?: PreviewMessageFile;
}) {
  const completion =
    message.role === "assistant" ? splitAssistantTurnCompletion(message.content) : null;
  const content = completion?.content ?? message.content;
  const text = copyableText(content);
  if (message.role === "user") {
    return (
      <div
        className="group/message flex min-w-0 scroll-mt-4 flex-col items-end"
        data-msg-index={index}
      >
        <div className="user-bubble relative min-w-0 max-w-[85%] break-words rounded-2xl bg-bubble px-4 py-2.5 whitespace-pre-wrap text-ink sm:max-w-[75%]">
          <div className="chat-message-text"><Blocks blocks={message.content} markdown={false} cwd={cwd} onPreviewFile={onPreviewFile} /></div>
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
      <div className="chat-message-text min-w-0"><Blocks blocks={content} markdown cwd={cwd} onPreviewFile={onPreviewFile} /></div>
      {message.errorMessage && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
          {message.errorMessage}
        </div>
      )}
      {isTurnComplete && text && (
        <AssistantTurnFooter
          text={text}
          summary={completion?.summary}
          completedAt={message.completedAt ?? message.timestamp}
        />
      )}
    </div>
  );
});
export function EmptyStateHero({ cwd, agent }: { cwd?: string; agent: UIAgentKind }) {
  const t = useT();
  const starterPrompts = [
    {
      icon: "🔍",
      title: t("starterTitleExplore"),
      desc: t("starterExploreCodebase"),
      prompt: t("starterExploreCodebase"),
    },
    {
      icon: "🌿",
      title: t("starterTitleGit"),
      desc: t("starterReviewGit"),
      prompt: t("starterReviewGit"),
    },
    {
      icon: "🧪",
      title: t("starterTitleTests"),
      desc: t("starterWriteTests"),
      prompt: t("starterWriteTests"),
    },
    {
      icon: "⚡",
      title: t("starterTitlePerf"),
      desc: t("starterOptimizePerf"),
      prompt: t("starterOptimizePerf"),
    },
  ];

  const handleSelectStarter = (prompt: string) => {
    chatClient.refillComposer(prompt);
    chatClient.requestComposerFocus();
  };

  const projectFolder = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  const agentLabel = agent === "codex" ? t("agentCodex") : t("agentPi");

  return (
    <div className="my-auto flex flex-col items-center justify-center py-12 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-line bg-card shadow-xs">
        <AgentIcon
          agent={agent}
          size={34}
          className={agent === "codex" ? "text-amber-500" : "text-accent"}
          title={agentLabel}
        />
      </div>
      <h2 className="mt-4 text-lg font-semibold tracking-tight text-ink">
        {t("emptyPrompt")}
      </h2>
      {projectFolder && (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-full border border-line bg-card/60 px-2.5 py-0.5 font-mono text-[11px] text-muted">
          <span className="opacity-70">📁</span>
          <span className="truncate max-w-xs">{projectFolder}</span>
        </div>
      )}

      <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-2 text-left">
        {starterPrompts.map((item, i) => (
          <button
            key={i}
            type="button"
            onClick={() => handleSelectStarter(item.prompt)}
            className="group flex flex-col rounded-xl border border-line bg-card/70 p-3 transition-all hover:border-accent/40 hover:bg-hover hover:shadow-xs active:scale-[0.99]"
          >
            <div className="flex items-center gap-2">
              <span className="text-base">{item.icon}</span>
              <span className="text-xs font-semibold text-ink group-hover:text-accent transition-colors">
                {item.title}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">
              {item.desc}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  streamText,
  streamThinking,
  streamThinkingComplete,
  activeTools,
  isStreaming,
  historyHasMore,
  historyLoading,
  onLoadOlder,
  containerRef,
  cwd,
  agent,
  onPreviewFile,
}: {
  messages: UIMessage[];
  streamText: string;
  streamThinking: string;
  streamThinkingComplete: boolean;
  activeTools: ActiveTool[];
  isStreaming: boolean;
  historyHasMore: boolean;
  historyLoading: boolean;
  onLoadOlder: () => Promise<boolean>;
  /** Scroll container (owned externally for message-anchor jumps) */
  containerRef: React.RefObject<HTMLDivElement | null>;
  cwd?: string;
  agent: UIAgentKind;
  onPreviewFile?: PreviewMessageFile;
}) {
  const t = useT();
  const chatFontSize = useChatFontSize();
  const stickToBottom = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const chatStyle = {
    "--chat-font-size": `${chatFontSizePixels(chatFontSize)}px`,
  } as CSSProperties;

  const loadOlder = async () => {
    const container = containerRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    stickToBottom.current = false;
    setIsAtBottom(false);
    const loaded = await onLoadOlder();
    if (!loaded) return;
    requestAnimationFrame(() => {
      const current = containerRef.current;
      if (!current) return;
      current.scrollTop = previousTop + (current.scrollHeight - previousHeight);
    });
  };

  const scrollToBottomSmooth = () => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setIsAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

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
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stickToBottom.current = atBottom;
          setIsAtBottom(atBottom);
        }}
        className="thin-scroll h-full overflow-x-hidden overflow-y-auto"
      >
        <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-4 px-3 py-4 sm:gap-5 sm:px-4 sm:py-5 min-h-full">
          {historyHasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={historyLoading}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-card px-3 text-xs text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
              >
                {historyLoading && <LoadingIndicator label="" size="sm" />}
                {t("loadEarlierMessages")}
              </button>
            </div>
          )}
          {messages.length === 0 && !streamText && (
            <EmptyStateHero cwd={cwd} agent={agent} />
          )}
          {messages.map((m, i) => (
            <Message
              key={i}
              message={m}
              index={m.role === "user" ? i : undefined}
              isTurnComplete={isAssistantTurnComplete(messages, i, isStreaming)}
              cwd={cwd}
              onPreviewFile={onPreviewFile}
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
              <Markdown
                text={streamText}
                streaming
                cwd={cwd}
                onPreviewFile={onPreviewFile}
              />
            </div>
          )}
          {activeTools.map((tool) => <ActiveToolCard key={tool.toolCallId} tool={tool} />)}
          {showTyping && <LoadingIndicator label={t("loading")} size="sm" />}
        </div>
      </div>

      {/* Floating scroll to bottom / generating pill */}
      {!isAtBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottomSmooth}
          aria-label={t("scrollToBottom")}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-line bg-card/95 px-3 py-1.5 text-xs font-medium text-ink shadow-md backdrop-blur-sm transition-all hover:bg-hover hover:scale-105 active:scale-95"
        >
          {isStreaming && (
            <span className="size-2 animate-pulse rounded-full bg-accent" aria-hidden />
          )}
          <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2" aria-hidden>
            <path d="M12 5v14M19 12l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{isStreaming ? t("generatingResponse") : t("scrollToBottom")}</span>
        </button>
      )}
    </div>
  );
}
