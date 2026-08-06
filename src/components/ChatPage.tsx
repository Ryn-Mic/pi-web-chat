import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { chatClient, useChat } from "../lib/chat";
import { requestOpenSessionsDrawer } from "../lib/drawer";
import { useT } from "../lib/i18n";
import { consumeSuppressResume, getLastSessionId, useResumeEnabled } from "../lib/resume";
import { useSidebarPinned } from "../lib/sidebar";
import { useLeftEdgeSwipe } from "../lib/useEdgeSwipe";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionsDrawer, SessionsSidebar } from "./SessionsDrawer";
import { SettingsMenu } from "./SettingsMenu";

function connectionDotClass(connection: "connecting" | "connected" | "disconnected"): string {
  switch (connection) {
    case "connected":
      return "bg-emerald-500/80";
    case "connecting":
      return "bg-amber-400 animate-pulse";
    case "disconnected":
      return "bg-red-500";
  }
}

function connectionLabel(
  connection: "connecting" | "connected" | "disconnected",
  t: ReturnType<typeof useT>,
): string {
  switch (connection) {
    case "connected":
      return t("connected");
    case "connecting":
      return t("connecting");
    case "disconnected":
      return t("disconnected");
  }
}

export function ChatPage() {
  const t = useT();
  const { connection, sessionId, snapshot, streamText, streamThinking, activeTools, updateAvailable, lastError } =
    useChat();
  const isStreaming = snapshot?.isStreaming ?? false;
  const sidebarPinned = useSidebarPinned();
  const showConnectingOverlay = connection !== "connected" && !snapshot;
  const params = useParams({ strict: false }) as { sessionId?: string };
  const routeSessionId = params.sessionId ?? null;
  const navigate = useNavigate();
  const resumeEnabled = useResumeEnabled();

  // URL → 연결 ("/"는 아직 id 없는 초안, 첫 입력 때 서버가 session_bound)
  // "마지막 세션 복원"이 켜져 있고 / (초안) 진입 시 이전 세션으로 이동.
  // 단, "새 세션" 버튼으로 명시적으로 연 경우는 suppressResumeOnce()가
  // 리다이렉트를 막아 진짜 새 초안으로 간다.
  useEffect(() => {
    if (routeSessionId) {
      chatClient.connect(routeSessionId);
      return;
    }
    if (resumeEnabled && !consumeSuppressResume()) {
      const last = getLastSessionId();
      if (last) {
        void navigate({ to: "/s/$sessionId", params: { sessionId: last }, replace: true });
        return;
      }
    }
    chatClient.connect(null);
  }, [routeSessionId, resumeEnabled, navigate]);

  // 연결 → URL (첫 메시지 / 포크 등으로 세션이 공개되면 주소 교체).
  // 렌더 시점 값이 아닌 현재 상태를 읽어 "/"로 갔다가 즉시 되돌아오는 경합을 막는다.
  useEffect(() => {
    const bound = chatClient.state.sessionId;
    if (bound && bound !== routeSessionId) {
      void navigate({
        to: "/s/$sessionId",
        params: { sessionId: bound },
        replace: true,
      });
    }
  }, [sessionId, routeSessionId, navigate]);

  // 왼쪽 가장자리 → 오른쪽 스와이프로 세션 드로어 열기 (고정 사이드바 아닐 때)
  useLeftEdgeSwipe({
    enabled: !sidebarPinned,
    onSwipeRight: requestOpenSessionsDrawer,
  });

  // #root is the flex/dvh shell; fill it (no position:fixed — iOS 26 safe).
  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sidebar">
      {sidebarPinned && <SessionsSidebar currentSessionFile={snapshot?.sessionFile} />}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas md:my-2 md:mr-2 md:rounded-2xl md:border md:border-line md:shadow-sm">
        <header className="flex shrink-0 items-center gap-1 px-2.5 py-2 pt-[max(0.5rem,var(--safe-top))]">
          <SessionsDrawer currentSessionFile={snapshot?.sessionFile} />
          <div className="flex min-w-0 items-center gap-2 px-1">
            {!sidebarPinned && <span className="truncate text-sm font-medium text-ink">pi</span>}
            <span
              className={`size-1.5 shrink-0 rounded-full ${connectionDotClass(connection)}`}
              title={connectionLabel(connection, t)}
              aria-label={connectionLabel(connection, t)}
            />
          </div>
          <div className="flex-1" />
          <SettingsMenu />
        </header>

        {showConnectingOverlay ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span
              className={`size-2.5 rounded-full ${connectionDotClass(connection)}`}
              aria-hidden
            />
            <p className="text-sm text-muted">
              {connection === "disconnected" ? t("connectionLost") : t("connectingHint")}
            </p>
          </div>
        ) : (
          <>
            <MessageList
              messages={snapshot?.messages ?? []}
              streamText={streamText}
              streamThinking={streamThinking}
              activeTools={activeTools}
              isStreaming={isStreaming}
            />
            {updateAvailable && (
              <div className="flex shrink-0 items-center justify-center gap-3 border-t border-line bg-card px-4 py-2">
                <span className="text-xs text-muted">{t("updateAvailable")}</span>
                <button
                  type="button"
                  onClick={() => {
                    // PWA 캐시를 비운 뒤 새로고침 → 최신 번들 보장
                    const reload = () => window.location.reload();
                    if ("caches" in window) {
                      caches
                        .keys()
                        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
                        .catch(() => {})
                        .finally(reload);
                    } else {
                      reload();
                    }
                  }}
                  className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-accent-ink transition-opacity hover:opacity-90"
                >
                  {t("reload")}
                </button>
              </div>
            )}
            {lastError && (
              <div className="flex shrink-0 items-center gap-3 border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
                <span className="min-w-0 flex-1 break-words">{lastError}</span>
                <button
                  type="button"
                  onClick={() => chatClient.clearError()}
                  className="shrink-0 rounded-lg border border-current px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80"
                >
                  {t("dismiss")}
                </button>
              </div>
            )}
            <Composer isStreaming={isStreaming} />
          </>
        )}
      </div>
    </div>
  );
}
