import { useEffect, useMemo, useRef, useState } from "react";
import type { UIImageAttachment } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { chatFontSizePixels, useChatFontSize } from "../lib/chatFontSize";
import { getComposerDraft, setComposerDraft } from "../lib/composer-drafts";
import { useT } from "../lib/i18n";
import { CommandPalette, commandMatches } from "./CommandPalette";
import { ForkDialog } from "./ForkDialog";
import { MessageAnchors } from "./MessageAnchors";
import { ModelMenu } from "./ModelMenu";
import { ActiveTodoBadge, BranchBadge, TodoProgress } from "./ProjectBadge";
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
  containerRef,
  tabKey,
}: {
  isStreaming: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  tabKey: string;
}) {
  const t = useT();
  const initialDraft = useState(() => getComposerDraft(tabKey))[0];
  const [text, setText] = useState(initialDraft.text);
  const [images, setImages] = useState<PendingImage[]>(initialDraft.images);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [commandPaletteDismissed, setCommandPaletteDismissed] = useState(false);
  const [modelOpenToken, setModelOpenToken] = useState(0);
  const [forkOpen, setForkOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingPromptRef = useRef(false);
  const submittedPromptRef = useRef<{ text: string; images: PendingImage[] } | null>(null);
  const responseTokenRef = useRef(0);
  const failureTokenRef = useRef(0);
  const {
    injectText,
    focusToken,
    snapshot,
    commands,
    commandIntent,
    promptStatus,
    promptResponseToken,
    promptFailureToken,
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
  const waitingForPromptResponse = promptStatus === "waiting";
  const promptResponseStarted = promptStatus === "responding";

  useEffect(() => {
    if (promptResponseToken === responseTokenRef.current) return;
    responseTokenRef.current = promptResponseToken;
    if (!pendingPromptRef.current) return;

    pendingPromptRef.current = false;
    const submittedPrompt = submittedPromptRef.current;
    submittedPromptRef.current = null;
    const sameImages =
      submittedPrompt !== null &&
      images.length === submittedPrompt.images.length &&
      images.every(
        (image, index) =>
          image.data === submittedPrompt.images[index]?.data &&
          image.mimeType === submittedPrompt.images[index]?.mimeType,
      );
    if (!submittedPrompt || text.trim() !== submittedPrompt.text || !sameImages) return;

    setText("");
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [promptResponseToken]);

  useEffect(() => {
    if (promptFailureToken === failureTokenRef.current) return;
    failureTokenRef.current = promptFailureToken;
    // Keep the submitted prompt in the composer so it can be retried after a
    // timeout or server error. The ChatClient status makes the send button
    // available again.
    pendingPromptRef.current = false;
    submittedPromptRef.current = null;
  }, [promptFailureToken]);

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
  }, [commandIntent]);

  const commandToken = text.trimStart().slice(1).split(/\s/, 1)[0] ?? "";
  const commandMode = text.trimStart().startsWith("/") && !/\s/.test(text.trimStart().slice(1));
  const matchingCommands = useMemo(() => commandMatches(commands, text), [commands, text]);
  const commandPaletteOpen = commandMode && !commandPaletteDismissed;

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [commandToken, commands]);

  const addFiles = async (files: Iterable<File>) => {
    const loaded = await Promise.all([...files].map(fileToImage));
    setImages((prev) => [...prev, ...loaded.filter((i): i is PendingImage => i !== null)]);
  };

  const send = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || waitingForPromptResponse) return;

    pendingPromptRef.current = true;
    submittedPromptRef.current = { text: trimmed, images: [...images] };
    responseTokenRef.current = promptResponseToken;
    failureTokenRef.current = promptFailureToken;
    chatClient.send({
      type: "prompt",
      text: trimmed,
      images: images.length > 0 ? images.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
    });
  };

  const completeCommand = (name: string, argumentHint?: string) => {
    setText(`/${name}${argumentHint ? " " : ""}`);
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
            <ActiveTodoBadge todo={snapshot.activeTodo} isStreaming={isStreaming} />
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
      <div className="composer-panel rounded-2xl border border-line bg-card px-2 pt-2 pb-2 shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-colors focus-within:border-faint">
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
            placeholder={isStreaming ? t("streamingPlaceholder") : t("sendMessage")}
            className="composer-textarea max-h-40 w-full resize-none bg-transparent px-3 pt-2 pb-1 leading-relaxed text-ink outline-none placeholder:text-faint"
            style={{ "--composer-font-size": `${chatFontSizePixels(chatFontSize)}px` } as React.CSSProperties}
            onChange={(e) => {
              setText(e.target.value);
              setCommandPaletteDismissed(false);
              if (e.target.value.trimStart() === "/") chatClient.send({ type: "get_commands" });
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
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
              className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors hover:bg-hover hover:text-ink"
              aria-label={t("attachImage")}
              title={t("attachImage")}
            >
              <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-[1.8]">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
            <ModelMenu current={snapshot?.model ?? null} openToken={modelOpenToken} />
            <ThinkingMenu
              current={snapshot?.thinkingLevel ?? "off"}
              levels={snapshot?.thinkingLevels ?? ["off"]}
            />
            <div className="flex-1" />
            <span
              className={`flex size-8 shrink-0 items-center justify-center ${hasContext ? "" : "invisible"}`}
              aria-hidden={!hasContext}
              title={contextTitle}
            >
              {hasContext && <ContextRing percent={contextPercent} />}
            </span>
            <MessageAnchors
              messages={snapshot?.messages ?? []}
              containerRef={containerRef}
              compact
            />
            {isStreaming || promptResponseStarted ? (
              <button
                onClick={() => chatClient.send({ type: "abort" })}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition-opacity hover:opacity-85"
                aria-label={t("abort")}
              >
                <svg viewBox="0 0 24 24" className="size-3 fill-current">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : waitingForPromptResponse ? (
              <button
                type="button"
                disabled
                className="flex size-8 shrink-0 cursor-wait items-center justify-center rounded-full bg-accent text-accent-ink opacity-70"
                aria-label={t("send")}
                aria-busy="true"
              >
                <svg viewBox="0 0 24 24" className="size-[18px] animate-spin fill-none stroke-current stroke-2">
                  <circle cx="12" cy="12" r="8" strokeDasharray="34 16" strokeLinecap="round" />
                </svg>
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim() && images.length === 0}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-30"
                aria-label={t("send")}
              >
                <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-2">
                  <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
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
