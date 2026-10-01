import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { UIMessage, UIMessageAnchor } from "../../shared/protocol";
import { setModalOverlayOpen } from "../lib/drawer";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { computeVisibleTicks, firstLoadedUserOrdinal, messageIndexForUserOrdinal, TAIL_EPSILON_PX, viewportUserOrdinal } from "../lib/message-anchors";
import { LoadingIndicator } from "./LoadingIndicator";
import { DismissActionIcon } from "./MorphIcons";

function relativeAge(timestamp: number, formatter: Intl.RelativeTimeFormat): string {
  const age = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

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
  smooth = true,
): void {
  const el = containerRef.current?.querySelector<HTMLElement>(`[data-msg-index="${index}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  if (smooth) {
    const bubble = el.querySelector<HTMLElement>(".user-bubble");
    const target = bubble ?? el;
    target.classList.remove("anchor-flash");
    void target.offsetWidth;
    target.classList.add("anchor-flash");
  }
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
  /**
   * Called before a jump scrolls the transcript. The message list uses it to
   * stop following the tail: an auto-follow re-pin during the jump animation
   * would cancel the scroll and leave the highlight on the target while the
   * viewport sits at the bottom.
   */
  onAnchorJump?: () => void;
  hide?: boolean;
}

/**
 * Timeline ticks on the right edge of the chat viewport representing user message nodes.
 * Features:
 * - Up to 7 ticks, centered vertically;
 * - Current message tick is bolder and longer (accent color);
 * - Gestures: Slide / Scrub on ticks to directly scroll the message viewport in real time;
 * - First tap/click expands message card previews;
 * - Automatically collapses after 2 seconds of inactivity;
 * - Direct jumping to message nodes with anchor flash animation.
 */
export const MessageTimelineTicks = memo(function MessageTimelineTicks({
  sessionId,
  messages,
  historyHasMore,
  historyLoading,
  onLoadMessageAnchors,
  onLoadHistoryThroughUserMessage,
  containerRef,
  onAnchorJump,
  hide = false,
}: MessageTimelineTicksProps) {
  const t = useT();
  const locale = useLocale();
  const relativeFormatter = useMemo(
    () => new Intl.RelativeTimeFormat(localeTag(locale), { numeric: "always", style: "short" }),
    [locale],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fullOutlineOpen, setFullOutlineOpen] = useState(false);
  const [anchors, setAnchors] = useState<UIMessageAnchor[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [loadingOrdinal, setLoadingOrdinal] = useState<number | null>(null);
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedAnchor, setFailedAnchor] = useState<UIMessageAnchor | null>(null);

  const requestVersion = useRef(0);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Loaded user-message count the current anchor index was read against. */
  const indexedUserCountRef = useRef<number | null>(null);

  // Dragging / Scrubbing state
  const isScrubbingRef = useRef(false);
  const pointerStartYRef = useRef(0);
  const hasDraggedRef = useRef(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubbingOrdinal, setScrubbingOrdinal] = useState<number | null>(null);
  const [scrubbingTooltipY, setScrubbingTooltipY] = useState<number | null>(null);

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

  // Ticks, flyout labels and the highlight are all indexed by GLOBAL ordinal,
  // while `userEntries` numbers the loaded page from 1.
  const firstLoadedOrdinal = firstLoadedUserOrdinal(totalUserCount, userEntries.length);

  /** Loaded entry for a global ordinal, or null when that page is not loaded yet. */
  const entryForOrdinal = useCallback(
    (ordinal: number) => userEntries[ordinal - firstLoadedOrdinal] ?? null,
    [firstLoadedOrdinal, userEntries],
  );

  /**
   * Rendered user bubbles keyed by transcript index. The nodes are stable for as
   * long as their message stays mounted, so the map is rebuilt when the loaded
   * page changes instead of running a `querySelector` per entry on every scroll
   * frame. A detached first node means the map outlived its DOM and is rebuilt.
   */
  const userNodeMapRef = useRef<{ map: Map<number, HTMLElement>; first: HTMLElement } | null>(null);
  const userNodes = useCallback((): Map<number, HTMLElement> | null => {
    const container = containerRef.current;
    if (!container) return null;
    const cached = userNodeMapRef.current;
    if (cached && cached.map.size === userEntries.length && cached.first.isConnected) {
      return cached.map;
    }
    const map = new Map<number, HTMLElement>();
    for (const el of container.querySelectorAll<HTMLElement>("[data-msg-index]")) {
      const index = Number(el.dataset.msgIndex);
      if (Number.isSafeInteger(index) && !map.has(index)) map.set(index, el);
    }
    if (map.size === 0) return null;
    userNodeMapRef.current = { map, first: map.values().next().value! };
    return map;
  }, [containerRef, userEntries.length]);

  /**
   * Absolute content offsets of every loaded prompt, rebuilt only when the
   * content height or the loaded page changes. Scrolling never moves a prompt
   * inside the content, so the per-frame work stays at integer comparisons and
   * the scroll handler stops reading layout once the offsets are cached.
   */
  const userOffsetCacheRef = useRef<
    { height: number; count: number; offsets: { ordinal: number; offset: number }[] } | null
  >(null);
  const userOffsets = useCallback(
    (container: HTMLDivElement): { ordinal: number; offset: number }[] | null => {
      const height = container.scrollHeight;
      const cached = userOffsetCacheRef.current;
      if (cached && cached.height === height && cached.count === userEntries.length) {
        return cached.offsets;
      }
      const nodes = userNodes();
      if (!nodes) return null;
      const containerTop = container.getBoundingClientRect().top;
      const scrollTop = container.scrollTop;
      const offsets: { ordinal: number; offset: number }[] = [];
      for (const entry of userEntries) {
        const el = nodes.get(entry.index);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        // A collapsed/hidden message has a zero rect and no reading position.
        if (rect.height === 0) continue;
        offsets.push({
          ordinal: firstLoadedOrdinal + entry.ordinal - 1,
          offset: rect.top - containerTop + scrollTop,
        });
      }
      userOffsetCacheRef.current = { height, count: userEntries.length, offsets };
      return offsets;
    },
    [firstLoadedOrdinal, userEntries, userNodes],
  );

  // Initialize current visible ordinal to latest user message when available
  const [currentVisibleOrdinal, setCurrentVisibleOrdinal] = useState<number>(() => {
    return userEntries.length > 0 ? totalUserCount : 1;
  });

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
    indexedUserCountRef.current = null;
    clearTimer();
    // Only a session switch resets the widget. A new message must not collapse an
    // open flyout or throw away the anchor index that is still valid for it.
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

  // Track the user message the viewport is anchored to: the last question whose
  // top edge reached the top of the viewport. This is the exact line
  // `scrollToMessage` aligns to, so a jump always reads back as its own tick.
  // Re-runs whenever the loaded suffix or the total count changes, which also
  // re-anchors the highlight after a session switch or a history page load.
  const updateVisibleOrdinal = useCallback(() => {
    if (isScrubbingRef.current) return;
    const container = containerRef.current;
    if (!container || userEntries.length === 0) return;

    // 1. Viewport pinned to the end: the newest question is authoritative.
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <= TAIL_EPSILON_PX;
    if (isAtBottom) {
      setCurrentVisibleOrdinal(totalUserCount);
      return;
    }

    const offsets = userOffsets(container);
    if (!offsets) return;

    setCurrentVisibleOrdinal(viewportUserOrdinal(offsets, container.scrollTop) ?? firstLoadedOrdinal);
  }, [containerRef, firstLoadedOrdinal, totalUserCount, userEntries.length, userOffsets]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("scroll", updateVisibleOrdinal, { passive: true });
    updateVisibleOrdinal();
    return () => container.removeEventListener("scroll", updateVisibleOrdinal);
  }, [containerRef, updateVisibleOrdinal]);

  useEffect(() => {
    updateVisibleOrdinal();
  }, [messages.length, updateVisibleOrdinal]);

  useEffect(() => {
    if (pendingOrdinal === null || anchors === null) return;
    const index = messageIndexForUserOrdinal(messages, anchors.length, pendingOrdinal);
    if (index === null) return;
    const frame = requestAnimationFrame(() => {
      onAnchorJump?.();
      scrollToMessage(containerRef, index, true);
      setPendingOrdinal(null);
      setLoadingOrdinal(null);
      setExpanded(false);
      setFullOutlineOpen(false);
      clearTimer();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchors, containerRef, messages, onAnchorJump, pendingOrdinal, clearTimer]);

  const requestAnchors = useCallback(() => {
    if (indexLoading) return;
    const version = requestVersion.current;
    const loadedCountAtRequest = userEntries.length;
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
        indexedUserCountRef.current = loadedCountAtRequest;
      })
      .finally(() => {
        if (requestVersion.current === version) setIndexLoading(false);
      });
  }, [indexLoading, onLoadMessageAnchors, userEntries.length]);

  // Pre-fetch anchor count when history exists
  useEffect(() => {
    if (historyHasMore && anchors === null && !indexLoading) {
      requestAnchors();
    }
  }, [historyHasMore, anchors, indexLoading, requestAnchors]);

  // A newly loaded user message makes the index stale by one. Only a loaded-count
  // change refreshes it, so streaming updates and history prepends do not refetch
  // the index once per message.
  useEffect(() => {
    if (anchors === null || indexLoading) return;
    if (indexedUserCountRef.current === userEntries.length) return;
    requestAnchors();
  }, [anchors, indexLoading, requestAnchors, userEntries.length]);

  const scrollToOrdinal = useCallback(
    (targetOrdinal: number, smooth = true) => {
      if (loadingOrdinal !== null || historyLoading) return;
      const total = anchors?.length ?? totalUserCount;
      const index = messageIndexForUserOrdinal(messages, total, targetOrdinal);

      if (index !== null) {
        onAnchorJump?.();
        scrollToMessage(containerRef, index, smooth);
        setCurrentVisibleOrdinal(targetOrdinal);
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
    },
    [anchors, containerRef, historyLoading, loadingOrdinal, messages, onAnchorJump, onLoadHistoryThroughUserMessage, totalUserCount],
  );

  const jumpToOrdinal = useCallback(
    (targetOrdinal: number) => {
      scrollToOrdinal(targetOrdinal, true);
      setExpanded(false);
      setFullOutlineOpen(false);
      clearTimer();
    },
    [clearTimer, scrollToOrdinal],
  );

  const getPromptText = useCallback(
    (ord: number) => {
      if (anchors) {
        const a = anchors.find((item) => item.ordinal === ord);
        if (a?.text) return a.text;
      }
      const local = entryForOrdinal(ord);
      if (local?.text) return local.text;
      return `#${ord}`;
    },
    [anchors, entryForOrdinal],
  );

  const handleToggleExpand = useCallback(() => {
    if (!expanded) {
      setExpanded(true);
      if (anchors === null && !indexLoading) {
        requestAnchors();
      }
    } else {
      setExpanded(false);
      clearTimer();
    }
  }, [anchors, clearTimer, expanded, indexLoading, requestAnchors]);

  // Resolve which tick button is closest to the pointer clientY
  const resolveOrdinalFromPoint = useCallback(
    (clientY: number): { ordinal: number; relativeY: number } | null => {
      const track = trackRef.current;
      if (!track) return null;
      const trackRect = track.getBoundingClientRect();
      const buttons = Array.from(track.querySelectorAll<HTMLButtonElement>("button[data-ordinal]"));
      if (buttons.length === 0) return null;

      let closestOrdinal = visibleTicks[0] ?? 1;
      let minDistance = Infinity;
      let targetCenterY = trackRect.top + trackRect.height / 2;

      for (const btn of buttons) {
        const ord = Number(btn.getAttribute("data-ordinal"));
        if (!ord) continue;
        const rect = btn.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        const distance = Math.abs(clientY - centerY);
        if (distance < minDistance) {
          minDistance = distance;
          closestOrdinal = ord;
          targetCenterY = centerY;
        }
      }

      const relativeY = targetCenterY - trackRect.top;
      return { ordinal: closestOrdinal, relativeY };
    },
    [visibleTicks],
  );

  // Pointer scrubbing handlers (slide to scroll)
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointerStartYRef.current = e.clientY;
    hasDraggedRef.current = false;
    isScrubbingRef.current = true;
    setIsScrubbing(true);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const resolved = resolveOrdinalFromPoint(e.clientY);
    if (resolved) {
      setScrubbingOrdinal(resolved.ordinal);
      setScrubbingTooltipY(resolved.relativeY);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current) return;
    const dy = Math.abs(e.clientY - pointerStartYRef.current);
    if (dy > 4) {
      hasDraggedRef.current = true;
    }

    const resolved = resolveOrdinalFromPoint(e.clientY);
    if (resolved) {
      setScrubbingOrdinal(resolved.ordinal);
      setScrubbingTooltipY(resolved.relativeY);

      if (hasDraggedRef.current) {
        // Direct real-time scroll while sliding
        scrollToOrdinal(resolved.ordinal, false);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current) return;
    const wasDragging = hasDraggedRef.current;
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    setScrubbingOrdinal(null);
    setScrubbingTooltipY(null);

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (!wasDragging) {
      // Tap/click: toggle outline preview flyout
      handleToggleExpand();
    } else {
      // Finished scrubbing: reset 2s collapse timer
      resetAutoCloseTimer();
    }
  };

  const handlePointerCancel = () => {
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    setScrubbingOrdinal(null);
    setScrubbingTooltipY(null);
  };

  if (hide || (userEntries.length < 2 && !historyHasMore)) return null;

  return (
    <aside
      ref={rootRef}
      role="navigation"
      aria-label={t("questionsList")}
      className="absolute right-1 sm:right-2.5 top-1/2 -translate-y-1/2 z-20 flex items-center select-none pointer-events-auto"
    >
      {/* Real-time floating scrubber badge during sliding */}
      {isScrubbing && hasDraggedRef.current && scrubbingOrdinal !== null && (
        <div
          className="absolute right-full mr-2.5 flex items-center gap-2 rounded-xl border border-line/70 bg-card/95 px-3 py-1.5 shadow-xl backdrop-blur-md dark:border-white/[0.1] dark:bg-[#20201e]/95 pointer-events-none select-none z-30 animate-in fade-in duration-100"
          style={{
            top: scrubbingTooltipY !== null ? `${scrubbingTooltipY}px` : "50%",
            transform: "translateY(-50%)",
          }}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent text-[10.5px] font-mono font-semibold text-accent-ink shadow-2xs">
            #{scrubbingOrdinal}
          </span>
          <span className="max-w-[180px] truncate text-[12px] font-medium text-ink leading-tight">
            {getPromptText(scrubbingOrdinal)}
          </span>
        </div>
      )}

      {/* Expanded flyout card */}
      {expanded && (
        <div
          onMouseEnter={resetAutoCloseTimer}
          onMouseMove={resetAutoCloseTimer}
          onTouchStart={resetAutoCloseTimer}
          onWheel={resetAutoCloseTimer}
          onClick={(e) => e.stopPropagation()}
          className="absolute right-full mr-2.5 top-1/2 -translate-y-1/2 w-64 sm:w-72 max-w-[calc(100vw-3.5rem)] flex flex-col rounded-2xl border border-line/70 bg-card/95 p-1.5 shadow-xl backdrop-blur-md dark:border-white/[0.1] dark:bg-[#20201e]/95 animate-in fade-in zoom-in-95 duration-150"
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
                  onClick={() => jumpToOrdinal(ord)}
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

      {/* Vertical ticks track with touch-none for smooth scrubbing */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className="group/ticks flex flex-col items-end gap-1.5 py-2 px-1 rounded-full cursor-pointer transition-all hover:bg-black/5 dark:hover:bg-white/5 touch-none"
        title={`${t("questionsList")} (${currentVisibleOrdinal}/${totalUserCount})`}
      >
        {visibleTicks[0] > 1 && (
          <span className="mr-0.5 size-1 rounded-full bg-muted/40 transition-opacity" />
        )}

        {visibleTicks.map((ord) => {
          const isCurrent = ord === (isScrubbing && scrubbingOrdinal !== null ? scrubbingOrdinal : currentVisibleOrdinal);
          return (
            <button
              key={ord}
              type="button"
              tabIndex={-1}
              data-ordinal={ord}
              onClick={(e) => {
                e.stopPropagation();
                if (expanded) {
                  jumpToOrdinal(ord);
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
                        {relativeAge(anchor.timestamp, relativeFormatter)}
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
});

export const PromptNavigator = MessageTimelineTicks;
export const MessageAnchors = MessageTimelineTicks;
