import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { UIMessage, UIMessageAnchor } from "../../shared/protocol";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { messageIndexForUserOrdinal } from "../lib/message-anchors";
import { LoadingIndicator } from "./LoadingIndicator";

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

function scrollToMessage(
  containerRef: RefObject<HTMLDivElement | null>,
  index: number,
): void {
  const el = containerRef.current?.querySelector<HTMLElement>(`[data-msg-index="${index}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  const bubble = el.querySelector<HTMLElement>(".user-bubble");
  const target = bubble ?? el;
  target.classList.remove("anchor-flash");
  void target.offsetWidth;
  target.classList.add("anchor-flash");
}

/**
 * User-message anchor navigation. The list comes from a lightweight server
 * index; transcript pages are fetched only until the selected message exists.
 */
export function MessageAnchors({
  sessionId,
  messages,
  historyHasMore,
  historyLoading,
  onLoadMessageAnchors,
  onLoadHistoryThroughUserMessage,
  containerRef,
  compact = false,
}: {
  sessionId: string | null;
  messages: UIMessage[];
  historyHasMore: boolean;
  historyLoading: boolean;
  onLoadMessageAnchors: () => Promise<UIMessageAnchor[] | null>;
  onLoadHistoryThroughUserMessage: (
    ordinal: number,
    totalUserMessages: number,
  ) => Promise<boolean>;
  containerRef: RefObject<HTMLDivElement | null>;
  compact?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [anchors, setAnchors] = useState<UIMessageAnchor[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [loadingOrdinal, setLoadingOrdinal] = useState<number | null>(null);
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedAnchor, setFailedAnchor] = useState<UIMessageAnchor | null>(null);
  const requestVersion = useRef(0);

  const loadedUserCount = useMemo(
    () => messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0),
    [messages],
  );

  useEffect(() => {
    requestVersion.current += 1;
    setOpen(false);
    setAnchors(null);
    setIndexLoading(false);
    setLoadingOrdinal(null);
    setPendingOrdinal(null);
    setLoadFailed(false);
    setFailedAnchor(null);
  }, [sessionId]);

  useEffect(() => {
    if (pendingOrdinal === null || anchors === null) return;
    const index = messageIndexForUserOrdinal(messages, anchors.length, pendingOrdinal);
    if (index === null) return;
    const frame = requestAnimationFrame(() => {
      scrollToMessage(containerRef, index);
      setPendingOrdinal(null);
      setLoadingOrdinal(null);
      setOpen(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [anchors, containerRef, messages, pendingOrdinal]);

  if (loadedUserCount < 2 && !historyHasMore) return null;

  const requestAnchors = () => {
    if (indexLoading) return;
    const version = requestVersion.current;
    setIndexLoading(true);
    setLoadFailed(false);
    setFailedAnchor(null);
    void onLoadMessageAnchors()
      .then((result) => {
        if (requestVersion.current !== version) return;
        if (result === null) {
          setLoadFailed(true);
          return;
        }
        setAnchors(result);
      })
      .finally(() => {
        if (requestVersion.current === version) setIndexLoading(false);
      });
  };

  const close = () => {
    setOpen(false);
    setPendingOrdinal(null);
    setLoadingOrdinal(null);
  };

  const jump = (anchor: UIMessageAnchor) => {
    if (!anchors || loadingOrdinal !== null || historyLoading) return;
    const index = messageIndexForUserOrdinal(messages, anchors.length, anchor.ordinal);
    if (index !== null) {
      scrollToMessage(containerRef, index);
      setOpen(false);
      return;
    }

    const version = requestVersion.current;
    setLoadingOrdinal(anchor.ordinal);
    setPendingOrdinal(anchor.ordinal);
    setLoadFailed(false);
    setFailedAnchor(null);
    void onLoadHistoryThroughUserMessage(anchor.ordinal, anchors.length)
      .then((loaded) => {
        if (requestVersion.current !== version || loaded) return;
        setPendingOrdinal(null);
        setLoadingOrdinal(null);
        setLoadFailed(true);
        setFailedAnchor(anchor);
      })
      .catch(() => {
        if (requestVersion.current !== version) return;
        setPendingOrdinal(null);
        setLoadingOrdinal(null);
        setLoadFailed(true);
        setFailedAnchor(anchor);
      });
  };

  const openAnchors = () => {
    setOpen(true);
    requestAnchors();
  };

  return (
    <>
      <button
        type="button"
        onClick={openAnchors}
        aria-label={t("messageAnchors")}
        title={t("messageAnchors")}
        className={`flex items-center justify-center text-faint transition-colors hover:bg-hover hover:text-ink ${
          compact ? "size-8 rounded-full" : "size-9 rounded-lg"
        }`}
      >
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
          onClick={close}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative z-10 flex max-h-[65vh] w-full flex-col rounded-t-2xl bg-card shadow-2xl outline-none md:max-w-sm md:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={t("messageAnchors")}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
              <span className="text-sm font-medium text-ink">{t("messageAnchors")}</span>
              <button
                type="button"
                onClick={close}
                aria-label={t("cancel")}
                className="flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                  <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="thin-scroll overflow-y-auto py-1">
              {(indexLoading || loadingOrdinal !== null || historyLoading) && (
                <div className="flex justify-center px-4 py-3" role="status">
                  <LoadingIndicator label={t("loading")} size="sm" showLabel />
                </div>
              )}
              {loadFailed && !indexLoading && loadingOrdinal === null && (
                <button
                  type="button"
                  onClick={() => (failedAnchor ? jump(failedAnchor) : requestAnchors())}
                  className="w-full px-4 py-3 text-center text-xs text-faint hover:bg-hover hover:text-ink"
                >
                  {t("treeLoadError")}
                </button>
              )}
              {anchors?.map((anchor) => (
                <button
                  key={anchor.id}
                  type="button"
                  disabled={loadingOrdinal !== null || historyLoading}
                  onClick={() => jump(anchor)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover disabled:opacity-50"
                >
                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-selected px-1 text-[11px] text-muted tabular-nums">
                    {anchor.ordinal}
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {anchor.text || t("emptyMessage")}
                    </span>
                    {anchor.timestamp != null && (
                      <span
                        className="shrink-0 text-[11px] text-faint tabular-nums"
                        title={new Date(anchor.timestamp).toLocaleString(localeTag(locale))}
                      >
                        {relativeAge(anchor.timestamp, locale)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
