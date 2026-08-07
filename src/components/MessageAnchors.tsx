import { useMemo, useState } from "react";
import type { UIMessage } from "../../shared/protocol";
import { localeTag, useLocale, useT } from "../lib/i18n";

function relativeAge(timestamp: number, locale: ReturnType<typeof useLocale>): string {
  const age = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const formatter = new Intl.RelativeTimeFormat(localeTag(locale), {
    numeric: "always",
    style: "short",
  });

  if (age < hour) return formatter.format(-Math.max(1, Math.floor(age / minute)), "minute");
  if (age < day) return formatter.format(-Math.floor(age / hour), "hour");
  return formatter.format(-Math.floor(age / day), "day");
}

/**
 * User-message anchor navigation (composer button + bottom sheet):
 * lists user messages, tapping one scrolls to it and flashes the bubble.
 */
export function MessageAnchors({
  messages,
  containerRef,
  compact = false,
}: {
  messages: UIMessage[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  compact?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const userAnchors = useMemo(() => {
    const anchors: { index: number; ordinal: number }[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user") anchors.push({ index: i, ordinal: anchors.length + 1 });
    });
    return anchors.reverse();
  }, [messages]);

  if (userAnchors.length < 2) return null;

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
        className={`flex items-center justify-center text-faint transition-colors hover:bg-hover hover:text-ink ${
          compact ? "size-8 rounded-full" : "size-9 rounded-lg"
        }`}
      >
        {/* map icon (lucide map) */}
        <svg
          viewBox="0 0 24 24"
          className={`${compact ? "size-[18px]" : "size-5"} fill-none stroke-current stroke-2`}
        >
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
              {userAnchors.map(({ index, ordinal }) => {
                const m = messages[index]!;
                const text =
                  m.content
                    .filter((b): b is { type: "text"; text: string } => b.type === "text")
                    .map((b) => b.text)
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim() || t("emptyMessage");
                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => jump(index)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover"
                  >
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-selected px-1 text-[11px] text-muted tabular-nums">
                      {ordinal}
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{text}</span>
                      {m.timestamp != null && (
                        <span
                          className="shrink-0 text-[11px] text-faint tabular-nums"
                          title={new Date(m.timestamp).toLocaleString(localeTag(locale))}
                        >
                          {relativeAge(m.timestamp, locale)}
                        </span>
                      )}
                    </span>
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
