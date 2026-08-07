import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { chatClient, useChat } from "../lib/chat";
import { requestOpenSessionsDrawer } from "../lib/drawer";
import { useT } from "../lib/i18n";
import { consumeSuppressResume, getLastSessionId, suppressResumeOnce, useResumeEnabled } from "../lib/resume";
import { useSidebarPinned } from "../lib/sidebar";
import { useLeftEdgeSwipe } from "../lib/useEdgeSwipe";
import { Composer } from "./Composer";
import { ExtensionUIHost } from "./ExtensionUIHost";
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
  const {
    connection,
    sessionId,
    snapshot,
    streamText,
    streamThinking,
    streamThinkingComplete,
    activeTools,
    updateAvailable,
    lastError,
    lastNotice,
    commandIntent,
  } =
    useChat();
  const isStreaming = snapshot?.isStreaming ?? false;
  const sidebarPinned = useSidebarPinned();
  const showConnectingOverlay = connection !== "connected" && !snapshot;
  const params = useParams({ strict: false }) as { sessionId?: string };
  const routeSessionId = params.sessionId ?? null;
  const navigate = useNavigate();
  const resumeEnabled = useResumeEnabled();
  const messageListRef = useRef<HTMLDivElement>(null);
  const [settingsOpenToken, setSettingsOpenToken] = useState(0);

  // URL → connection ("/" is a draft without an id yet; the server sends
  // session_bound on the first input)
  // With "resume last session" on, an entry via / (draft) moves to the
  // previous session. An explicit "new session" button call suppresses the
  // redirect once so a real fresh draft is created.
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

  // Connection → URL (address rewrites once the session is published: first
  // message / fork etc.). Reads the current state instead of the render-time
  // value to avoid a "to / and right back" race.
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

  // Left edge → right swipe opens the session drawer (when not docked)
  useLeftEdgeSwipe({
    enabled: !sidebarPinned,
    onSwipeRight: requestOpenSessionsDrawer,
  });

  useEffect(() => {
    if (!commandIntent) return;
    if (commandIntent.action === "open_settings") {
      setSettingsOpenToken((token) => token + 1);
      chatClient.consumeCommandIntent();
    } else if (commandIntent.action === "open_sessions") {
      requestOpenSessionsDrawer();
      chatClient.consumeCommandIntent();
    } else if (commandIntent.action === "new_session") {
      suppressResumeOnce();
      void navigate({ to: "/" });
      chatClient.connect(null, { force: true });
      chatClient.requestComposerFocus();
      chatClient.consumeCommandIntent();
    }
  }, [commandIntent, navigate]);

  // #root is the flex/dvh shell; fill it (no position:fixed — iOS 26 safe).
  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sidebar">
      {sidebarPinned && <SessionsSidebar currentSessionFile={snapshot?.sessionFile} />}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas md:my-2 md:mr-2 md:rounded-2xl md:border md:border-line md:shadow-sm">
        <header className="flex shrink-0 items-center gap-1 px-2.5 py-2 pt-[calc(max(0.5rem,var(--safe-top))+0.25rem)]">
          <SessionsDrawer currentSessionFile={snapshot?.sessionFile} />
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            {!sidebarPinned && (
              <span className="shrink-0 text-sm font-medium text-ink">pi</span>
            )}
            <span
              className={`size-1.5 shrink-0 rounded-full ${connectionDotClass(connection)}`}
              title={connectionLabel(connection, t)}
              aria-label={connectionLabel(connection, t)}
            />
          </div>
          <SettingsMenu openToken={settingsOpenToken} />
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
              streamThinkingComplete={streamThinkingComplete}
              activeTools={activeTools}
              isStreaming={isStreaming}
              containerRef={messageListRef}
            />
            {updateAvailable && (
              <div className="flex shrink-0 items-center justify-center gap-3 border-t border-line bg-card px-4 py-2">
                <span className="text-xs text-muted">{t("updateAvailable")}</span>
                <button
                  type="button"
                  onClick={() => {
                    // Clear the PWA cache first, then reload → newest bundle guaranteed
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
            {lastNotice && (
              <div className="flex shrink-0 items-center gap-3 border-t border-line bg-card px-4 py-2 text-sm text-muted">
                <span className="min-w-0 flex-1 break-words">{lastNotice}</span>
                <button
                  type="button"
                  onClick={() => chatClient.clearNotice()}
                  className="shrink-0 rounded-lg border border-line px-2 py-0.5 text-xs font-medium transition-colors hover:bg-hover hover:text-ink"
                >
                  {t("dismiss")}
                </button>
              </div>
            )}
            <Composer isStreaming={isStreaming} containerRef={messageListRef} />
          </>
        )}
        <ExtensionUIHost />
      </div>
    </div>
  );
}
