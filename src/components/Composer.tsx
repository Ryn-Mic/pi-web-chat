import { useEffect, useRef, useState } from "react";
import type { UIImageAttachment } from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { useT } from "../lib/i18n";

interface PendingImage extends UIImageAttachment {
  previewUrl: string;
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
  const { injectText, focusToken } = useChat();

  // fork 후 선택된 메시지 텍스트를 composer에 주입
  useEffect(() => {
    if (injectText !== null) {
      setText(injectText);
      chatClient.consumeInjectText();
      textareaRef.current?.focus();
    }
  }, [injectText]);

  // 새 세션 등에서 입력창 포커스 요청
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
      <div className="mx-auto max-w-3xl rounded-2xl border border-line bg-card px-2 pt-2 pb-2 shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-colors focus-within:border-faint">
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
              // 데스크탑: Enter로 전송, 모바일(터치)은 버튼 사용
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                const isTouch = window.matchMedia("(pointer: coarse)").matches;
                if (!isTouch) {
                  e.preventDefault();
                  send();
                }
              }
            }}
          />
          {/* 하단 컨트롤 행 (Claude/ChatGPT desktop 레이아웃) */}
          <div className="mt-1 flex items-center gap-1 px-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors hover:bg-hover hover:text-ink"
              aria-label={t("attachImage")}
            >
              <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-[1.8]">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
            <div className="flex-1" />
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
