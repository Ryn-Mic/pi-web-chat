import { useEffect, useMemo, useRef, useState } from "react";
import type { UIImageAttachment, UIMessage, UIMessageAnchor } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { chatFontSizePixels, useChatFontSize } from "../lib/chatFontSize";
import { getComposerDraft, setComposerDraft } from "../lib/composer-drafts";
import { useFileSearch } from "../lib/api";
import { useT } from "../lib/i18n";
import { extractMentionQuery, replaceMentionToken } from "../lib/mention";
import { CommandPalette, commandMatches } from "./CommandPalette";
import { FileMentionPalette } from "./FileMentionPalette";
import { ForkDialog } from "./ForkDialog";
import { MessageAnchors } from "./MessageAnchors";
import { LoadingIndicator } from "./LoadingIndicator";
import { ModelMenu } from "./ModelMenu";
import { ActiveTodoBadge, BranchBadge, TodoProgress } from "./ProjectBadge";
import { RemoteActionIcon } from "./RemoteActionIcon";
import { ThinkingMenu } from "./ThinkingMenu";

interface PendingImage extends UIImageAttachment {
  previewUrl: string;
}

/** 12345 → "12.3k", 1234567 → "1.2M" */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ContextRing({ percent }: { percent: number }) {
  const pct = Math.min(100, Math.max(0, percent));
  const tier = pct >= 90 ? "text-ink" : pct >= 65 ? "text-muted" : "text-faint";
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;
  return (
    <svg viewBox="0 0 18 18" className={`size-4 shrink-0 ${tier}`} aria-hidden>
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.18" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference - dash}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

function ContextRingPopover({
  context,
  percent,
}: {
  context?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | null;
  percent: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pct = Math.min(100, Math.max(0, percent));

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const used = context?.tokens;
  const max = context?.contextWindow;

  return (
    <div ref={ref} className="relative flex items-center justify-center">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-hover"
        aria-label={t("contextDetails")}
        aria-expanded={open}
      >
        <ContextRing percent={percent} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 z-30 w-60 rounded-xl border border-line bg-card p-3 shadow-lg text-xs">
          <div className="flex items-center justify-between font-medium text-ink">
            <span>{t("contextDetails")}</span>
            <span className="font-mono text-[11px] text-muted">{Math.round(pct)}%</span>
          </div>

          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className={`h-full transition-all ${pct >= 90 ? "bg-red-500" : pct >= 65 ? "bg-amber-500" : "bg-accent"}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {used != null && max != null && (
            <div className="mt-2.5 space-y-1 font-mono text-[11px]">
              <div className="flex justify-between text-muted">
                <span>{t("contextUsed")}:</span>
                <span className="text-ink font-medium">{formatTokens(used)}</span>
              </div>
              <div className="flex justify-between text-muted">
                <span>{t("contextWindowSize")}:</span>
                <span className="text-ink">{formatTokens(max)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function fileToImage(file: File): Promise<PendingImage | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { data: base64, mimeType: file.type, previewUrl: dataUrl };
}

export function Composer({
  isStreaming,
  sessionId,
  messages,
  historyHasMore,
  historyLoading,
  onLoadMessageAnchors,
  onLoadHistoryThroughUserMessage,
  containerRef,
  tabKey,
}: {
  isStreaming: boolean;
  sessionId: string | null;
  messages: UIMessage[];
  historyHasMore: boolean;
  historyLoading: boolean;
  onLoadMessageAnchors: () => Promise<UIMessageAnchor[] | null>;
  onLoadHistoryThroughUserMessage: (
    ordinal: number,
    totalUserMessages: number,
  ) => Promise<boolean>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  tabKey: string;
}) {
  const t = useT();
  const initialDraft = useState(() => getComposerDraft(tabKey))[0];
  const [text, setText] = useState(initialDraft.text);
  const [images, setImages] = useState<PendingImage[]>(initialDraft.images);
  const [processingImages, setProcessingImages] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [commandPaletteDismissed, setCommandPaletteDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [debouncedMentionQuery, setDebouncedMentionQuery] = useState("");
  const [modelOpenToken, setModelOpenToken] = useState(0);
  const [forkOpen, setForkOpen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoredPromptRef = useRef<unknown>(null);
  const {
    injectText,
    focusToken,
    snapshot,
    commands,
    commandIntent,
    promptStatus,
    restorePrompt,
  } = useChat();
  const chatFontSize = useChatFontSize();
  const context = snapshot?.context;
  const contextPercent = context?.percent ?? null;
  const hasProjectStatus = Boolean(snapshot?.gitBranch || snapshot?.activeTodo);
  const hasContext = contextPercent !== null;
  const contextTitle =
    context?.tokens != null && context.contextWindow != null
      ? `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)} tokens (${Math.round(contextPercent ?? 0)}%)`
      : hasContext
        ? `${Math.round(contextPercent)}%`
        : undefined;
  const promptInFlight = promptStatus !== "idle";
  const running = isStreaming || promptStatus === "running";
  const codexRunning = snapshot?.agent === "codex" && running;
  // Read-only observation of a Codex session owned by another client: the
  // user can watch it but cannot prompt, steer or abort.
  const codexObserver = snapshot?.agent === "codex" && snapshot?.codex?.observer === true;
  const codexCanSteer =
    codexRunning
    && (promptStatus === "idle" || promptStatus === "running");
  // The steer-send button only appears while a Codex turn is running when the
  // user is actually composing a steering message; an empty cleared input must
  // leave a single stop button (matching the pi look) instead of a duplicate
  // round send button.
  const canSubmit = !(processingImages || (!text.trim() && images.length === 0));
  const remoteActionMode: "pending" | "stop" | "send" =
    codexObserver || ((!running && promptInFlight) || (codexRunning && !codexCanSteer))
      ? "pending"
      : running
        ? "stop"
        : "send";
  const remoteActionDisabled =
    remoteActionMode === "pending" || (remoteActionMode === "send" && !canSubmit);

  useEffect(() => {
    if (!restorePrompt || restorePrompt === restoredPromptRef.current) return;
    restoredPromptRef.current = restorePrompt;
    // Do not overwrite text the user started composing while the request was
    // in flight. The failed optimistic bubble remains visible either way.
    if (text || images.length > 0) return;
    setText(restorePrompt.text);
    setImages(
      restorePrompt.images.map((image) => ({
        ...image,
        previewUrl: `data:${image.mimeType};base64,${image.data}`,
      })),
    );
  }, [images.length, restorePrompt, text]);


  // Keep unsent text and attachments isolated to the active session tab. The
  // component is keyed by tab in ChatPage, so switching tabs restores that
  // tab's draft instead of sending another session's input.
  useEffect(() => {
    setComposerDraft(tabKey, { text, images });
  }, [tabKey, text, images]);

  // Inject text into the composer: "replace" refills (fork, reuse), "insert"
  // splices at the caret (file reference from the tree panel).
  useEffect(() => {
    if (injectText === null) return;
    chatClient.consumeInjectText();
    const el = textareaRef.current;
    if (injectText.mode === "replace") {
      setText(injectText.text);
      setCaret(injectText.text.length);
      el?.focus();
      return;
    }
    if (!el) {
      setText((prev) => prev + injectText.text);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText((prev) => prev.slice(0, start) + injectText.text + prev.slice(end));
    const caret = start + injectText.text.length;
    setCaret(caret);
    el.focus();
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [injectText]);

  // Focus the input on new session etc.
  useEffect(() => {
    if (focusToken <= 0) return;
    textareaRef.current?.focus();
    chatClient.clearComposerFocus();
  }, [focusToken]);

  useEffect(() => {
    if (!commandIntent) return;
    if (commandIntent.action === "open_model") {
      setModelOpenToken((token) => token + 1);
      chatClient.consumeCommandIntent();
    } else if (commandIntent.action === "open_fork") {
      setForkOpen(true);
      chatClient.consumeCommandIntent();
    } else if (commandIntent.action === "copy_text") {
      const originatingTabKey = chatClient.activeTabKey;
      void navigator.clipboard
        .writeText(commandIntent.text)
        .then(() => {
          if (originatingTabKey) {
            chatClient.reportNoticeFor(
              originatingTabKey,
              "Copied the last assistant message.",
            );
          }
        })
        .catch(() => {
          if (originatingTabKey) {
            chatClient.reportErrorFor(
              originatingTabKey,
              "The browser could not copy this message.",
            );
          }
        });
      chatClient.consumeCommandIntent();
    }
  }, [commandIntent, snapshot?.agent]);

  const mention = useMemo(() => extractMentionQuery(text, caret), [text, caret]);
  // Mention wins over the command palette: derive it independently, then gate commandPaletteOpen with !mentionMode.
  const mentionMode = mention !== null && !mentionDismissed;
  const commandToken = text.trimStart().slice(1).split(/\s/, 1)[0] ?? "";
  const commandMode = text.trimStart().startsWith("/") && !/\s/.test(text.trimStart().slice(1));
  const matchingCommands = useMemo(() => commandMatches(commands, text), [commands, text]);
  const commandPaletteOpen = commandMode && !commandPaletteDismissed && !mentionMode;

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedMentionQuery(mention?.query ?? ""), 150);
    return () => window.clearTimeout(id);
  }, [mention?.query]);

  const { data: mentionData, isPending: mentionPending, isFetching: mentionFetching } = useFileSearch(
    snapshot?.cwd,
    debouncedMentionQuery,
    mentionMode,
  );
  // placeholderData keeps the previous query's results in flight. Only use
  // them when they resolve the query currently being edited, otherwise a fast
  // Enter/Tab could commit a path from a stale query.
  const mentionMatches = useMemo(
    () => (mentionMode && mentionData?.query === mention?.query ? (mentionData?.matches ?? []) : []),
    [mentionMode, mentionData, mention?.query],
  );
  // Render and keyboard completion must agree on the selected item; clamp to
  // the visible range so a shrinking result set can never select a stale index.
  const safeMentionIndex =
    mentionMatches.length > 0 ? Math.min(activeMentionIndex, mentionMatches.length - 1) : 0;

  useEffect(() => {
    setActiveMentionIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [commandToken, commands]);

  const completeMention = (match: { path: string; type: "dir" | "file" }) => {
    const currentCaret = textareaRef.current?.selectionStart ?? caret;
    const currentMention = extractMentionQuery(text, currentCaret);
    if (!currentMention) return;
    const insert = `@${match.path}${match.type === "dir" ? "/" : ""} `;
    const { next, caret: nextCaret } = replaceMentionToken(text, currentMention.start, currentCaret, insert);
    setText(next);
    setCaret(nextCaret);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = nextCaret;
    });
  };

  const addFiles = async (files: Iterable<File>) => {
    setProcessingImages(true);
    try {
      const loaded = await Promise.all([...files].map(fileToImage));
      setImages((prev) => [...prev, ...loaded.filter((i): i is PendingImage => i !== null)]);
    } finally {
      setProcessingImages(false);
    }
  };

  const send = () => {
    const trimmed = text.trim();
    if (
      codexObserver
      || (!trimmed && images.length === 0)
      || (promptInFlight && !codexCanSteer)
      || processingImages
    ) return;

    const submittedImages = [...images];
    const sent = chatClient.send({
      type: "prompt",
      text: trimmed,
      images: submittedImages.length > 0 ? submittedImages.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
    });
    if (!sent) return;
    setText("");
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const completeCommand = (name: string, argumentHint?: string) => {
    const next = `/${name}${argumentHint ? " " : ""}`;
    setText(next);
    setCaret(next.length);
    setCommandPaletteDismissed(true);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  return (
    <div className="composer-bar shrink-0 bg-canvas md:rounded-b-2xl">
      {/* Keep this row mounted at first paint so late session metadata cannot
          change the composer's height or its keyboard position. */}
      <div
        className={`composer-status mx-auto flex h-7 max-w-3xl items-center gap-2 overflow-hidden px-2 ${
          hasProjectStatus ? "" : "invisible"
        }`}
        aria-hidden={!hasProjectStatus}
      >
        <BranchBadge gitBranch={snapshot?.gitBranch} />
        {/* Todo follows the branch; without a branch it starts at the row's left edge. */}
        {snapshot?.activeTodo && (
          <div
            className={`flex min-w-0 flex-1 items-center gap-2 border-l border-line/60 px-2 ${
              snapshot.gitBranch ? "" : "border-l-0 pl-0"
            }`}
          >
            <ActiveTodoBadge todo={snapshot.activeTodo} />
            <TodoProgress todo={snapshot.activeTodo} />
          </div>
        )}
      </div>
      <div className="relative mx-auto max-w-3xl">
        {commandPaletteOpen && (
          <CommandPalette
            matches={matchingCommands}
            activeIndex={Math.min(activeCommandIndex, Math.max(0, matchingCommands.length - 1))}
            onSelect={(command) => completeCommand(command.name, command.argumentHint)}
          />
        )}
        {mentionMode && (
          <FileMentionPalette
            matches={mentionMatches}
            activeIndex={safeMentionIndex}
            partial={mentionData?.partial}
            loading={mentionPending || (mentionFetching && mentionData?.query !== mention?.query)}
            onSelect={completeMention}
          />
        )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDraggingOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDraggingOver(false);
          const droppedFiles = e.dataTransfer?.files;
          if (droppedFiles && droppedFiles.length > 0) {
            void addFiles(droppedFiles);
          }
        }}
        className="composer-panel relative rounded-2xl border border-line bg-card px-2 pt-2 pb-2 shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-colors focus-within:border-faint"
      >
        {isDraggingOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-card/90 backdrop-blur-xs">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{t("dropFilesHere")}</span>
            </div>
          </div>
        )}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img
                  src={img.previewUrl}
                  alt=""
                  className="size-16 rounded-lg border border-line object-cover"
                />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-xs text-canvas"
                  aria-label={t("removeImage")}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-col">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            placeholder={
              codexCanSteer
                ? t("codexSteerPlaceholder")
                : isStreaming
                  ? t("streamingPlaceholder")
                  : t("sendMessage")
            }
            className="composer-textarea max-h-40 w-full resize-none bg-transparent px-3 pt-2 pb-1 leading-relaxed text-ink outline-none placeholder:text-faint"
            style={{ "--composer-font-size": `${chatFontSizePixels(chatFontSize)}px` } as React.CSSProperties}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? 0);
              setCommandPaletteDismissed(false);
              setMentionDismissed(false);
              if (e.target.value.trimStart() === "/") chatClient.send({ type: "get_commands" });
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (mentionMode && !e.nativeEvent.isComposing) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveMentionIndex(Math.min(safeMentionIndex + 1, Math.max(0, mentionMatches.length - 1)));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveMentionIndex(Math.max(safeMentionIndex - 1, 0));
                  return;
                }
                if ((e.key === "Tab" || e.key === "Enter") && mentionMatches[safeMentionIndex]) {
                  e.preventDefault();
                  completeMention(mentionMatches[safeMentionIndex]!);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionDismissed(true);
                  return;
                }
              }
              if (commandPaletteOpen && !e.nativeEvent.isComposing) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveCommandIndex((index) => Math.min(index + 1, Math.max(0, matchingCommands.length - 1)));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveCommandIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if (e.key === "Tab" && matchingCommands[activeCommandIndex]) {
                  e.preventDefault();
                  const command = matchingCommands[activeCommandIndex];
                  completeCommand(command.name, command.argumentHint);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCommandPaletteDismissed(true);
                  return;
                }
              }
              // Desktop: Enter sends; mobile (touch) uses the button
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                const isTouch = window.matchMedia("(pointer: coarse)").matches;
                if (!isTouch) {
                  e.preventDefault();
                  send();
                }
              }
            }}
          />
          {/* Bottom control row (Claude/ChatGPT desktop layout) */}
          <div className="mt-1 flex items-center gap-1 px-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={processingImages}
              className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
              aria-label={t("attachImage")}
              title={t("attachImage")}
            >
              {processingImages ? <LoadingIndicator label={t("loading")} size="sm" /> : <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-[1.8]">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>}
            </button>
            <ModelMenu current={snapshot?.model ?? null} openToken={modelOpenToken} />
            <ThinkingMenu
              current={snapshot?.thinkingLevel ?? "off"}
              levels={snapshot?.thinkingLevels ?? ["off"]}
            />
            <div className="flex-1" />
            <div
              className={`flex size-8 shrink-0 items-center justify-center ${hasContext ? "" : "invisible"}`}
              aria-hidden={!hasContext}
            >
              {hasContext && (
                <ContextRingPopover
                  context={context ?? undefined}
                  percent={contextPercent ?? 0}
                />
              )}
            </div>
            <MessageAnchors
              sessionId={sessionId}
              messages={messages}
              historyHasMore={historyHasMore}
              historyLoading={historyLoading}
              onLoadMessageAnchors={onLoadMessageAnchors}
              onLoadHistoryThroughUserMessage={onLoadHistoryThroughUserMessage}
              containerRef={containerRef}
              compact
            />
            <button
              type="button"
              onClick={() => {
                if (remoteActionMode === "stop") chatClient.send({ type: "abort" });
                else if (remoteActionMode === "send") send();
              }}
              disabled={remoteActionDisabled}
              aria-label={
                remoteActionMode === "stop"
                  ? t("abort")
                  : codexObserver
                    ? t("codexObserverTitle")
                    : t("send")
              }
              aria-busy={remoteActionMode === "pending" && !codexObserver}
              title={
                codexObserver
                  ? t("codexObserverHint")
                  : remoteActionMode === "stop"
                    ? t("abort")
                    : t("send")
              }
              className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity disabled:cursor-wait ${
                codexObserver
                  ? "bg-canvas text-faint ring-1 ring-line/70"
                  : remoteActionMode === "stop"
                    ? "bg-ink text-canvas hover:opacity-85"
                    : "bg-accent text-accent-ink hover:opacity-90"
              } ${
                remoteActionMode === "pending"
                  ? "opacity-70"
                  : remoteActionDisabled
                    ? "opacity-30"
                    : ""
              }`}
            >
              <RemoteActionIcon
                mode={remoteActionMode}
                size={19}
                className={codexObserver ? "text-faint" : remoteActionMode === "stop" ? "text-canvas" : "text-accent-ink"}
              />
            </button>
            {codexRunning && codexCanSteer && canSubmit && (
              <button
                type="button"
                onClick={send}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity hover:opacity-90"
                aria-label={t("send")}
                title={t("send")}
              >
                <RemoteActionIcon mode="send" size={19} className="text-accent-ink" />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      <ForkDialog open={forkOpen} onOpenChange={setForkOpen} />
    </div>
  );
}
