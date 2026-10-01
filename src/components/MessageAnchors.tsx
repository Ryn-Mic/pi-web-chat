import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { UIMessage, UIMessageAnchor } from "../../shared/protocol";
import { setModalOverlayOpen } from "../lib/drawer";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { messageIndexForUserOrdinal } from "../lib/message-anchors";
import { LoadingIndicator } from "./LoadingIndicator";
import { DismissActionIcon, NavigationActionIcon } from "./MorphIcons";

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

export interface PromptNavigatorProps {
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
  hide?: boolean;
}

/**
 * Floating prompt navigator (jump to previous/next user question and outline popover).
 */
export function PromptNavigator({
  sessionId,
  messages,
  historyHasMore,
  historyLoading,
  onLoadMessageAnchors,
  onLoadHistoryThroughUserMessage,
  containerRef,
  hide = false,
}: PromptNavigatorProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [anchors, setAnchors] = useState<UIMessageAnchor[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [loadingOrdinal, setLoadingOrdinal] = useState<number | null>(null);
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedAnchor, setFailedAnchor] = useState<UIMessageAnchor | null>(null);
  const [currentVisibleOrdinal, setCurrentVisibleOrdinal] = useState<number>(1);
  const requestVersion = useRef(0);

  const userEntries = useMemo(() => {
    const list: { index: number; ordinal: number }[] = [];
    let count = 0;
    messages.forEach((msg, idx) => {
      if (msg.role === "user") {
        count += 1;
        list.push({ index: idx, ordinal: count });
      }
    });
    return list;
  }, [messages]);

  const totalUserCount = anchors?.length ?? (historyHasMore ? userEntries.length + 1 : userEntries.length);

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
    setModalOverlayOpen(open);
    return () => setModalOverlayOpen(false);
  }, [open]);

  // Track the user message closest to the top of the viewport
  const updateVisibleOrdinal = useCallback(() => {
    const container = containerRef.current;
    if (!container || userEntries.length === 0) return;
    const containerTop = container.getBoundingClientRect().top;
    let closestOrdinal = userEntries[userEntries.length - 1]!.ordinal;
    let minDistance = Infinity;

    for (const entry of userEntries) {
      const el = container.querySelector<HTMLElement>(`[data-msg-index="${entry.index}"]`);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const distance = Math.abs(rect.top - containerTop);
      if (distance < minDistance) {
        minDistance = distance;
        closestOrdinal = entry.ordinal;
      }
    }
    setCurrentVisibleOrdinal(closestOrdinal);
  }, [containerRef, userEntries]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("scroll", updateVisibleOrdinal, { passive: true });
    updateVisibleOrdinal();
    return () => container.removeEventListener("scroll", updateVisibleOrdinal);
  }, [containerRef, updateVisibleOrdinal]);

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

  const requestAnchors = useCallback(() => {
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
  }, [indexLoading, onLoadMessageAnchors]);

  // Pre-fetch anchor count when history exists
  useEffect(() => {
    if (historyHasMore && anchors === null && !indexLoading) {
      requestAnchors();
    }
  }, [historyHasMore, anchors, indexLoading, requestAnchors]);

  if (hide || (userEntries.length < 2 && !historyHasMore)) return null;

  const jumpToOrdinal = (targetOrdinal: number) => {
    if (loadingOrdinal !== null || historyLoading) return;
    const total = anchors?.length ?? totalUserCount;
    const index = anchors
      ? messageIndexForUserOrdinal(messages, anchors.length, targetOrdinal)
      : userEntries.find((e) => e.ordinal === targetOrdinal)?.index ?? null;

    if (index !== null) {
      scrollToMessage(containerRef, index);
      setCurrentVisibleOrdinal(targetOrdinal);
      setOpen(false);
      return;
    }

    // Need to fetch earlier history
    const version = requestVersion.current;
    setLoadingOrdinal(targetOrdinal);
    setPendingOrdinal(targetOrdinal);
    setLoadFailed(false);
    setFailedAnchor(null);
    void onLoadHistoryThroughUserMessage(targetOrdinal, total)
      .then((loaded) => {
        if (requestVersion.current !== version || loaded) return;
        setPendingOrdinal(null);
        setLoadingOrdinal(null);
        setLoadFailed(true);
      })
      .catch(() => {
        if (requestVersion.current !== version) return;
        setPendingOrdinal(null);
        setLoadingOrdinal(null);
        setLoadFailed(true);
      });
  };

  const jumpPrev = () => {
    const prev = Math.max(1, currentVisibleOrdinal - 1);
    jumpToOrdinal(prev);
  };

  const jumpNext = () => {
    const next = Math.min(totalUserCount, currentVisibleOrdinal + 1);
    jumpToOrdinal(next);
  };

  const toggleOutline = () => {
    const next = !open;
    setOpen(next);
    if (next && anchors === null) {
      requestAnchors();
    }
  };

  const atFirst = currentVisibleOrdinal <= 1 && !historyHasMore;
  const atLast = currentVisibleOrdinal >= totalUserCount;

  return (
    <div className="absolute right-3.5 bottom-4 z-20 flex flex-col items-center rounded-2xl border border-line/70 bg-card/90 p-0.5 shadow-md backdrop-blur-md transition-all sm:right-4 dark:border-white/[0.08] dark:bg-card/80 dark:shadow-xl">
      <button
        type="button"
        disabled={atFirst || loadingOrdinal !== null}
        onClick={jumpPrev}
        aria-label={t("previousQuestion")}
        title={t("previousQuestion")}
        className="flex size-7 items-center justify-center rounded-xl text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <span className="rotate-180 flex items-center justify-center">
          <NavigationActionIcon direction="down" size={13} />
        </span>
      </button>

      <button
        type="button"
        onClick={toggleOutline}
        aria-label={t("questionsList")}
        title={`${t("questionsList")} (${currentVisibleOrdinal}/${totalUserCount})`}
        className="flex h-6 min-w-7 items-center justify-center px-1 font-mono text-[10.5px] font-semibold text-muted transition-colors hover:text-ink select-none"
      >
        {loadingOrdinal !== null ? (
          <LoadingIndicator label={t("loading")} size="sm" />
        ) : (
          <span>
            {currentVisibleOrdinal}/{totalUserCount}
          </span>
        )}
      </button>

      <button
        type="button"
        disabled={atLast || loadingOrdinal !== null}
        onClick={jumpNext}
        aria-label={t("nextQuestion")}
        title={t("nextQuestion")}
        className="flex size-7 items-center justify-center rounded-xl text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <NavigationActionIcon direction="down" size={13} />
      </button>

      {/* Floating outline popover */}
      {open && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center md:items-center"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
          <div
            className="relative z-10 flex max-h-[65vh] w-full flex-col rounded-t-2xl border border-line/60 bg-card shadow-2xl outline-none md:max-w-sm md:rounded-2xl dark:border-white/[0.08]"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={t("questionsList")}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
              <span className="text-sm font-medium text-ink">
                {t("questionsList")} ({totalUserCount})
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("cancel")}
                className="flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <DismissActionIcon size={14} />
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
                  onClick={() => (failedAnchor ? jumpToOrdinal(failedAnchor.ordinal) : requestAnchors())}
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
                  onClick={() => jumpToOrdinal(anchor.ordinal)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover disabled:opacity-50 ${
                    anchor.ordinal === currentVisibleOrdinal ? "bg-selected text-ink font-medium" : ""
                  }`}
                >
                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-bubble px-1 font-mono text-[11px] text-muted tabular-nums">
                    {anchor.ordinal}
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
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
        </div>,
        document.body,
      )}
    </div>
  );
}

export const MessageAnchors = PromptNavigator;
