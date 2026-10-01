import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { UIMessage, UIMessageAnchor } from "../../shared/protocol";
import { setModalOverlayOpen } from "../lib/drawer";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { isPersistedUserMessage, messageIndexForUserOrdinal } from "../lib/message-anchors";
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
  historyRevision?: number;
  onNavigate?: () => void;
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
  historyRevision = 0,
  onNavigate,
}: PromptNavigatorProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [anchorIndex, setAnchorIndex] = useState<{ key: object; anchors: UIMessageAnchor[] } | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [loadingOrdinal, setLoadingOrdinal] = useState<number | null>(null);
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedOrdinal, setFailedOrdinal] = useState<number | null>(null);
  const [visibleLocalOrdinal, setVisibleLocalOrdinal] = useState(1);
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  const inFlight = useRef<object | null>(null);

  const userEntries = useMemo(() => {
    const list: { index: number; ordinal: number }[] = [];
    messages.forEach((message, index) => {
      if (isPersistedUserMessage(message)) list.push({ index, ordinal: list.length + 1 });
    });
    return list;
  }, [messages]);
  const lastUser = userEntries.length ? messages[userEntries.at(-1)!.index] : null;
  const indexKey = useMemo(() => ({}), [sessionId, historyRevision, lastUser?.id ?? lastUser]);
  const currentKey = useRef(indexKey);
  currentKey.current = indexKey;
  const loadedUsers = useRef(userEntries.length);
  loadedUsers.current = userEntries.length;
  const anchors = anchorIndex?.key === indexKey ? anchorIndex.anchors : null;
  const indexKnown = anchors !== null || !historyHasMore;
  const totalUserCount = anchors?.length ?? userEntries.length;
  const offset = anchors ? Math.max(0, anchors.length - userEntries.length) : 0;
  const currentVisibleOrdinal = offset + Math.min(visibleLocalOrdinal, Math.max(1, userEntries.length));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current += 1; inFlight.current = null; };
  }, []);
  useEffect(() => {
    requestVersion.current += 1;
    inFlight.current = null;
    setAnchorIndex(null);
    setIndexLoading(false);
    setLoadingOrdinal(null);
    setPendingOrdinal(null);
    setLoadFailed(false);
    setFailedOrdinal(null);
  }, [indexKey]);
  useEffect(() => { setOpen(false); }, [sessionId]);
  useEffect(() => {
    setModalOverlayOpen(open);
    return () => setModalOverlayOpen(false);
  }, [open]);

  const updateVisibleOrdinal = useCallback(() => {
    const container = containerRef.current;
    if (!container || !userEntries.length) return;
    const top = container.getBoundingClientRect().top;
    let closest = userEntries.at(-1)!.ordinal;
    let distance = Infinity;
    for (const entry of userEntries) {
      const element = container.querySelector<HTMLElement>(`[data-msg-index="${entry.index}"]`);
      if (!element) continue;
      const next = Math.abs(element.getBoundingClientRect().top - top);
      if (next < distance) { distance = next; closest = entry.ordinal; }
    }
    setVisibleLocalOrdinal(closest);
  }, [containerRef, userEntries]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("scroll", updateVisibleOrdinal, { passive: true });
    updateVisibleOrdinal();
    return () => container.removeEventListener("scroll", updateVisibleOrdinal);
  }, [containerRef, updateVisibleOrdinal]);

  useEffect(() => {
    if (pendingOrdinal === null || !indexKnown) return;
    const index = messageIndexForUserOrdinal(messages, totalUserCount, pendingOrdinal);
    if (index === null) return;
    const container = containerRef.current;
    const key = indexKey;
    const frame = requestAnimationFrame(() => {
      if (!mounted.current || currentKey.current !== key || containerRef.current !== container || !container?.isConnected) return;
      scrollToMessage(containerRef, index);
      setPendingOrdinal(null);
      setLoadingOrdinal(null);
      setOpen(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [containerRef, indexKey, indexKnown, messages, pendingOrdinal, totalUserCount]);

  const requestAnchors = useCallback(() => {
    if (inFlight.current === indexKey) return;
    const key = indexKey;
    const version = ++requestVersion.current;
    inFlight.current = key;
    setIndexLoading(true);
    setLoadFailed(false);
    setFailedOrdinal(null);
    const owns = () => mounted.current && currentKey.current === key && requestVersion.current === version;
    void onLoadMessageAnchors().then((result) => {
      if (!owns()) return;
      if (!result || result.length < loadedUsers.current || result.some((anchor, i) => anchor.ordinal !== i + 1)) {
        setLoadFailed(true);
        return;
      }
      setAnchorIndex({ key, anchors: result });
    }).catch(() => { if (owns()) setLoadFailed(true); }).finally(() => {
      if (owns()) { inFlight.current = null; setIndexLoading(false); }
    });
  }, [indexKey, onLoadMessageAnchors]);
  useEffect(() => {
    if ((historyHasMore || open) && anchors === null && !indexLoading && !loadFailed) requestAnchors();
  }, [historyHasMore, open, anchors, indexLoading, loadFailed, requestAnchors]);

  if (hide || (userEntries.length < 2 && !historyHasMore)) return null;

  const jumpToOrdinal = (target: number) => {
    if (!indexKnown || loadingOrdinal !== null || historyLoading) return;
    onNavigate?.();
    const index = messageIndexForUserOrdinal(messages, totalUserCount, target);
    if (index !== null) {
      scrollToMessage(containerRef, index);
      setVisibleLocalOrdinal(target - offset);
      setOpen(false);
      return;
    }
    const key = indexKey;
    setLoadingOrdinal(target);
    setPendingOrdinal(target);
    setLoadFailed(false);
    setFailedOrdinal(null);
    const fail = () => {
      if (!mounted.current || currentKey.current !== key) return;
      setPendingOrdinal(null);
      setLoadingOrdinal(null);
      setFailedOrdinal(target);
      setLoadFailed(true);
    };
    void onLoadHistoryThroughUserMessage(target, totalUserCount).then((loaded) => { if (!loaded) fail(); }).catch(fail);
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
        disabled={!indexKnown || historyLoading || atFirst || loadingOrdinal !== null}
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
        {loadingOrdinal !== null || (!indexKnown && indexLoading) ? (
          <LoadingIndicator label={t("loading")} size="sm" />
        ) : (
          <span>
            {indexKnown ? currentVisibleOrdinal : "…"}/{indexKnown ? totalUserCount : "…"}
          </span>
        )}
      </button>

      <button
        type="button"
        disabled={!indexKnown || historyLoading || atLast || loadingOrdinal !== null}
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
                  onClick={() => (failedOrdinal !== null ? jumpToOrdinal(failedOrdinal) : requestAnchors())}
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
