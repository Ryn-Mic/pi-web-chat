import { useEffect, useRef, useState } from "react";
import type { UIImageAttachment } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { useComposerOpacity } from "../lib/composer";
import { useT } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { ModelMenu } from "./ModelMenu";
import { ThinkingMenu } from "./ThinkingMenu";

interface PendingImage extends UIImageAttachment {
  previewUrl: string;
}

/**
 * Blend the card color toward the canvas color by `alpha` (0..1) using JS.
 * color-mix() with CSS variables is broken in Safari < 17.2, so this avoids it
 * entirely — works in every browser.
 */
function blendCardOverCanvas(alpha: number): string | null {
  try {
    const cs = getComputedStyle(document.documentElement);
    const card = cs.getPropertyValue("--c-card").trim();
    const canvas = cs.getPropertyValue("--c-canvas").trim();
    const parse = (c: string): [number, number, number] | null => {
      const m = c.match(/^#([0-9a-f]{6})$/i);
      if (!m) return null;
      const n = parseInt(m[1]!, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const a = parse(card);
    const b = parse(canvas);
    if (!a || !b) return null;
    const mix = (i: number) => Math.round(a[i]! * alpha + b[i]! * (1 - alpha));
    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
  } catch {
    return null;
  }
}

/** 12345 → "12.3k", 1234567 → "1.2M" */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Context usage progress ring (font color; deeper when almost full)
 */
function ContextRing({ percent }: { percent: number }) {
  const pct = Math.min(100, Math.max(0, percent));
  // Low → faint, high → strong (red is not used)
  const tier =
    pct >= 90 ? "text-ink" : pct >= 65 ? "text-muted" : "text-faint";
  const r = 7;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <svg viewBox="0 0 18 18" className={`size-4 shrink-0 ${tier}`} aria-hidden>
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.18"
      />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
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

export function Composer({ isStreaming }: { isStreaming: boolean }) {
  const t = useT();
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { injectText, focusToken, snapshot } = useChat();
  const composerOpacity = useComposerOpacity();
  const theme = useTheme();
  // Compute the blended background in JS (color-mix + CSS vars is unreliable
  // in older Safari). Recompute on opacity or theme change.
  const [composerBg, setComposerBg] = useState<string | null>(null);
  useEffect(() => {
    if (composerOpacity >= 1) {
      setComposerBg(null);
      return;
    }
    setComposerBg(blendCardOverCanvas(composerOpacity));
  }, [composerOpacity, theme]);

  // Inject the forked message text into the composer
  useEffect(() => {
    if (injectText !== null) {
      setText(injectText);
      chatClient.consumeInjectText();
      textareaRef.current?.focus();
    }
  }, [injectText]);

  // Focus the input on new session etc.
  useEffect(() => {
    if (focusToken > 0) textareaRef.current?.focus();
  }, [focusToken]);

  const addFiles = async (files: Iterable<File>) => {
    const loaded = await Promise.all([...files].map(fileToImage));
    setImages((prev) => [...prev, ...loaded.filter((i): i is PendingImage => i !== null)]);
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    chatClient.send({
      type: "prompt",
      text: trimmed,
      images: images.length > 0 ? images.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
    });
    setText("");
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  return (
    <div className="composer-bar shrink-0 bg-canvas md:rounded-b-2xl">
      <div
        className="composer-panel mx-auto max-w-3xl rounded-2xl border border-line bg-card px-2 pt-2 pb-2 shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-colors focus-within:border-faint"
        style={composerBg ? ({ backgroundColor: composerBg } as React.CSSProperties) : undefined}
      >
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
            className="composer-textarea max-h-40 w-full resize-none bg-transparent px-3 pt-2 pb-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
            onChange={(e) => {
              setText(e.target.value);
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
            <ModelMenu current={snapshot?.model ?? null} />
            <ThinkingMenu
              current={snapshot?.thinkingLevel ?? "off"}
              levels={snapshot?.thinkingLevels ?? ["off"]}
            />
            <div className="flex-1" />
            {snapshot?.context?.percent != null && (
              <span
                className="flex size-8 items-center justify-center"
                title={
                  snapshot.context.tokens != null
                    ? `${formatTokens(snapshot.context.tokens)} / ${formatTokens(snapshot.context.contextWindow)} tokens (${Math.round(snapshot.context.percent)}%)`
                    : undefined
                }
              >
                <ContextRing percent={snapshot.context.percent} />
              </span>
            )}
            {isStreaming ? (
              <button
                onClick={() => chatClient.send({ type: "abort" })}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition-opacity hover:opacity-85"
                aria-label={t("abort")}
              >
                <svg viewBox="0 0 24 24" className="size-3 fill-current">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
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
  );
}
