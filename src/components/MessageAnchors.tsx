import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { UIMessage, UIMessageAnchor } from "../../shared/protocol";
import { setModalOverlayOpen } from "../lib/drawer";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { computeVisibleTicks, messageIndexForUserOrdinal } from "../lib/message-anchors";
import { LoadingIndicator } from "./LoadingIndicator";
import { DismissActionIcon } from "./MorphIcons";

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

function extractUserText(content: UIMessage["content"]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
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

export interface MessageTimelineTicksProps {
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
 * Timeline ticks on the right edge of the chat viewport representing user message nodes.
 * Features:
 * - Up to 7 ticks, centered vertically;
 * - Current message tick is bolder and longer;
 * - First tap/click expands message card previews;
 * - Automatically collapses after 2 seconds of inactivity;
 * - Direct jumping to message nodes with anchor flash animation.
 */
export function MessageTimelineTicks({
  sessionId,
  messages,
  historyHasMore,
  historyLoading,
  onLoadMessageAnchors,
  onLoadHistoryThroughUserMessage,
  containerRef,
  hide = false,
}: MessageTimelineTicksProps) {
  const t = useT();
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fullOutlineOpen, setFullOutlineOpen] = useState(false);
  const [anchors, setAnchors] = useState<UIMessageAnchor[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [loadingOrdinal, setLoadingOrdinal] = useState<number | null>(null);
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedAnchor, setFailedAnchor] = useState<UIMessageAnchor | null>(null);
  const [currentVisibleOrdinal, setCurrentVisibleOrdinal] = useState<number>(1);
  const requestVersion = useRef(0);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const userEntries = useMemo(() => {
    const list: { index: number; ordinal: number; text: string }[] = [];
    let count = 0;
    messages.forEach((msg, idx) => {
      if (msg.role === "user") {
        count += 1;
        list.push({
          index: idx,
          ordinal: count,
          text: extractUserText(msg.content),
        });
      }
    });
    return list;
  }, [messages]);

  const totalUserCount = anchors?.length ?? (historyHasMore ? userEntries.length + 1 : userEntries.length);

  const visibleTicks = useMemo(
    () => computeVisibleTicks(totalUserCount, currentVisibleOrdinal, 7),
    [totalUserCount, currentVisibleOrdinal],
  );

  const clearTimer = useCallback(() => {
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
  }, []);

  const resetAutoCloseTimer = useCallback(() => {
    clearTimer();
    autoCloseTimerRef.current = setTimeout(() => {
      setExpanded(false);
    }, 2000);
  }, [clearTimer]);

  useEffect(() => {
    if (expanded) {
      resetAutoCloseTimer();
    } else {
      clearTimer();
    }
    return clearTimer;
  }, [expanded, resetAutoCloseTimer, clearTimer]);

  useEffect(() => {
    requestVersion.current += 1;
    setExpanded(false);
    setFullOutlineOpen(false);
    setAnchors(null);
    setIndexLoading(false);
    setLoadingOrdinal(null);
    setPendingOrdinal(null);
    setLoadFailed(false);
    setFailedAnchor(null);
    clearTimer();
  }, [sessionId, clearTimer]);

  useEffect(() => {
    if (hide) {
      setExpanded(false);
      clearTimer();
    }
  }, [hide, clearTimer]);

  useEffect(() => {
    setModalOverlayOpen(fullOutlineOpen);
    return () => setModalOverlayOpen(false);
  }, [fullOutlineOpen]);

  // Click outside listener to collapse expanded card
  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setExpanded(false);
        clearTimer();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [expanded, clearTimer]);

  // Track user message closest to the top of viewport
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
      setExpanded(false);
      setFullOutlineOpen(false);
      clearTimer();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchors, containerRef, messages, pendingOrdinal, clearTimer]);

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

  const jumpToOrdinal = (targetOrdinal: number) => {
    if (loadingOrdinal !== null || historyLoading) return;
    const total = anchors?.length ?? totalUserCount;
    const index = anchors
      ? messageIndexForUserOrdinal(messages, anchors.length, targetOrdinal)
      : userEntries.find((e) => e.ordinal === targetOrdinal)?.index ?? null;

    if (index !== null) {
      scrollToMessage(containerRef, index);
      setCurrentVisibleOrdinal(targetOrdinal);
      setExpanded(false);
      setFullOutlineOpen(false);
      clearTimer();
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

  const getPromptText = useCallback(
    (ord: number) => {
      if (anchors) {
        const a = anchors.find((item) => item.ordinal === ord);
        if (a?.text) return a.text;
      }
      const local = userEntries.find((item) => item.ordinal === ord);
      if (local?.text) return local.text;
      return `#${ord}`;
    },
    [anchors, userEntries],
  );

  const handleToggleExpand = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!expanded) {
      setExpanded(true);
      if (anchors === null && !indexLoading) {
        requestAnchors();
      }
    } else {
      setExpanded(false);
      clearTimer();
    }
  };

  const handleSelectOrdinal = (ord: number) => {
    jumpToOrdinal(ord);
  };

  if (hide || (userEntries.length < 2 && !historyHasMore)) return null;

  return (
    <aside
      ref={rootRef}
      role="navigation"
      aria-label={t("questionsList")}
      className="absolute right-1 sm:right-2.5 top-1/2 -translate-y-1/2 z-20 flex items-center select-none pointer-events-auto"
    >
      {/* Expanded flyout card */}
      {expanded && (
        <div
          onMouseEnter={resetAutoCloseTimer}
          onMouseMove={resetAutoCloseTimer}
          onTouchStart={resetAutoCloseTimer}
          onWheel={resetAutoCloseTimer}
          onClick={(e) => e.stopPropagation()}
          className="absolute right-full mr-2 top-1/2 -translate-y-1/2 w-64 sm:w-72 max-w-[calc(100vw-3.5rem)] flex flex-col rounded-2xl border border-line/70 bg-card/95 p-1.5 shadow-xl backdrop-blur-md dark:border-white/[0.1] dark:bg-[#20201e]/95 animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-line/40 px-2 py-1.5 text-xs text-muted font-medium">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-accent animate-pulse" />
              {t("questionsList")}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-faint">
              {currentVisibleOrdinal} / {totalUserCount}
            </span>
          </div>

          <div className="flex flex-col gap-0.5 py-1">
            {visibleTicks.map((ord) => {
              const isCurrent = ord === currentVisibleOrdinal;
              const text = getPromptText(ord);
              return (
                <button
                  key={ord}
                  type="button"
                  disabled={loadingOrdinal !== null || historyLoading}
                  onClick={() => handleSelectOrdinal(ord)}
                  className={`group/item flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${
                    isCurrent
                      ? "bg-accent/10 text-accent font-medium dark:bg-accent/15"
                      : "text-ink hover:bg-hover"
                  }`}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-md font-mono text-[10.5px] tabular-nums transition-colors ${
                      isCurrent
                        ? "bg-accent text-accent-ink font-semibold shadow-2xs"
                        : "bg-bubble text-muted group-hover/item:text-ink"
                    }`}
                  >
                    {ord}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] leading-tight">
                    {text || t("emptyMessage")}
                  </span>
                  {isCurrent && (
                    <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                  )}
                </button>
              );
            })}
          </div>

          {totalUserCount > 7 && (
            <div className="border-t border-line/40 pt-1 px-1">
              <button
                type="button"
                onClick={() => {
                  setFullOutlineOpen(true);
                  setExpanded(false);
                  clearTimer();
                }}
                className="w-full rounded-lg py-1 text-center font-mono text-[11px] text-faint hover:bg-hover hover:text-ink transition-colors"
              >
                {t("questionsList")} · ({totalUserCount})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Vertical ticks track */}
      <div
        onClick={handleToggleExpand}
        className="group/ticks flex flex-col items-end gap-1.5 py-2 px-1 rounded-full cursor-pointer transition-all hover:bg-black/5 dark:hover:bg-white/5"
        title={`${t("questionsList")} (${currentVisibleOrdinal}/${totalUserCount})`}
      >
        {visibleTicks[0] > 1 && (
          <span className="mr-0.5 size-1 rounded-full bg-muted/40 transition-opacity" />
        )}

        {visibleTicks.map((ord) => {
          const isCurrent = ord === currentVisibleOrdinal;
          return (
            <button
              key={ord}
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                if (!expanded) {
                  handleToggleExpand(e);
                } else {
                  e.stopPropagation();
                  handleSelectOrdinal(ord);
                }
              }}
              aria-label={`${t("questionsList")} #${ord}`}
              className={`rounded-full transition-all duration-200 pointer-events-auto ${
                isCurrent
                  ? "w-4.5 sm:w-5 h-[3px] bg-accent shadow-xs"
                  : "w-2 sm:w-2.5 h-[2px] bg-line-strong/60 group-hover/ticks:bg-muted/70 hover:!w-3.5 hover:!bg-muted dark:bg-white/20 dark:group-hover/ticks:bg-white/35 dark:hover:!bg-white/60"
              }`}
            />
          );
        })}

        {visibleTicks[visibleTicks.length - 1] < totalUserCount && (
          <span className="mr-0.5 size-1 rounded-full bg-muted/40 transition-opacity" />
        )}
      </div>

      {/* Full outline modal fallback */}
      {fullOutlineOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center md:items-center"
          onClick={() => setFullOutlineOpen(false)}
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
                onClick={() => setFullOutlineOpen(false)}
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
    </aside>
  );
}

export const PromptNavigator = MessageTimelineTicks;
export const MessageAnchors = MessageTimelineTicks;
