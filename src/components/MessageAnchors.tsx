import { useMemo, useState } from "react";
import type { UIMessage } from "../../shared/protocol";
import { useT } from "../lib/i18n";

/**
 * User-message anchor navigation (header button + bottom sheet):
 * lists user messages, tapping one scrolls to it and flashes the bubble.
 */
export function MessageAnchors({
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
      void target.offsetWidth; // force reflow so the animation restarts
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
        className="flex size-9 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
      >
        {/* map icon (lucide map) */}
        <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-2">
          <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" />
          <path d="M15 5.764v15" />
          <path d="M9 3.236v15" />
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
