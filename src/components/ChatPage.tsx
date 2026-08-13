import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { chatClient, useChat } from "../lib/chat";
import { requestOpenFilesDrawer, requestOpenSessionsDrawer } from "../lib/drawer";
import { setFilesPanelOpen, useFilesPanelOpen } from "../lib/filetree";
import { useLocale, useT } from "../lib/i18n";
import {
  getLastSessionId,
  isFreshDraftRequested,
  markFreshDraftRequested,
  useResumeEnabled,
} from "../lib/resume";
import { useSidebarPinned } from "../lib/sidebar";
import { useTheme } from "../lib/theme";
import { useLeftEdgeSwipe, useRightEdgeSwipe } from "../lib/useEdgeSwipe";
import { Composer } from "./Composer";
import { ExtensionUIHost } from "./ExtensionUIHost";
import { FilesDrawer } from "./FileTreePanel";
import { MobileGitCommitDetail, type MobileGitCommitSelection } from "./MobileGitCommitDetail";
import { FileWorkspaceSidebar } from "./FileWorkspaceSidebar";
import { ProjectBadge } from "./ProjectBadge";
import { MessageList } from "./MessageList";
import {
  MobileFilePreview,
  type MobilePreviewSelection,
} from "./MobileFilePreview";
import { SessionTabs } from "./SessionTabs";
import { SessionsDrawer, SessionsSidebar } from "./SessionsDrawer";

function NewSessionIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-[1.8]" aria-hidden>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

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
  const theme = useTheme();
  const locale = useLocale();
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
    optimisticMessages,
    lastNotice,
    commandIntent,
    updateVersion,
    updateNotes,
  } =
    useChat();
  const isStreaming = snapshot?.isStreaming ?? false;
  const activeTabKey = chatClient.activeTabKey ?? "unbound";
  const sidebarPinned = useSidebarPinned();
  const showConnectingOverlay = connection !== "connected" && !snapshot;
  const params = useParams({ strict: false }) as { sessionId?: string };
  const routeSessionId = params.sessionId ?? null;
  const navigate = useNavigate();
  const resumeEnabled = useResumeEnabled();
  const messageListRef = useRef<HTMLDivElement>(null);
  const [settingsOpenToken, setSettingsOpenToken] = useState(0);
  const [mobilePreview, setMobilePreview] = useState<MobilePreviewSelection | null>(null);
  const [mobileGitCommit, setMobileGitCommit] = useState<MobileGitCommitSelection | null>(null);

  // URL → connection ("/" is a draft without an id yet; the server sends
  // session_bound on the first input)
  // With "resume last session" on, an entry via / (draft) moves to the
  // previous session. An explicit "new session" keeps resume suppressed until
  // the fresh draft is published.
  useEffect(() => {
    if (routeSessionId) {
      chatClient.connect(routeSessionId);
      return;
    }
    if (resumeEnabled && !isFreshDraftRequested()) {
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

  // Right edge → left swipe opens the files drawer (mirrors the sessions gesture).
  // Always enabled: the gesture is touch-only (mobile), so the desktop docked
  // panel state must not disable it — otherwise docking on desktop then
  // shrinking to a mobile width leaves the drawer unreachable by swipe.
  const filesPanelOpen = useFilesPanelOpen();
  const openFilesDrawer = useCallback(() => requestOpenFilesDrawer(), []);
  useRightEdgeSwipe({ enabled: true, onSwipeLeft: openFilesDrawer });

  useEffect(() => {
    if (!commandIntent) return;
    if (commandIntent.action === "open_settings") {
      setSettingsOpenToken((token) => token + 1);
      chatClient.consumeCommandIntent();
    } else if (commandIntent.action === "open_sessions") {
      requestOpenSessionsDrawer();
      chatClient.consumeCommandIntent();
    } else if (commandIntent.action === "new_session") {
      chatClient.consumeCommandIntent();
      markFreshDraftRequested();
      chatClient.connect(null, { force: true });
      void navigate({ to: "/" });
      chatClient.requestComposerFocus();
    }
  }, [commandIntent, navigate]);

  // The header files button toggles the docked panel on md+ and opens the
  // overlay drawer below. aria-pressed only describes the desktop toggle, so
  // on mobile it stays unset (the drawer has no pressed state).
  const isDesktop = window.matchMedia("(min-width: 768px)").matches;

  // #root is the flex/dvh shell; fill it (no position:fixed — iOS 26 safe).
  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sidebar">
      {sidebarPinned && (
        <SessionsSidebar
          currentSessionFile={snapshot?.sessionFile}
          settingsOpenToken={settingsOpenToken}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas md:my-2 md:mr-2 md:rounded-2xl md:border md:border-line md:shadow-sm">
        <header className="flex shrink-0 items-center gap-1 px-2.5 py-2 pt-[calc(max(0.5rem,var(--safe-top))+0.25rem)]">
          <SessionsDrawer
            currentSessionFile={snapshot?.sessionFile}
            settingsOpenToken={settingsOpenToken}
          />
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            {!sidebarPinned && (
              <span className="shrink-0 text-sm font-medium text-ink" aria-label="pi">
                &#x03c0;
              </span>
            )}
            <span
              className={`size-1.5 shrink-0 rounded-full ${connectionDotClass(connection)}`}
              title={connectionLabel(connection, t)}
              aria-label={connectionLabel(connection, t)}
            />
            <ProjectBadge cwd={snapshot?.cwd} />
          </div>
          <button
            type="button"
            onClick={() => {
              // Desktop toggles the docked panel; mobile opens the overlay drawer
              if (window.matchMedia("(min-width: 768px)").matches) {
                setFilesPanelOpen(!filesPanelOpen);
              } else {
                requestOpenFilesDrawer();
              }
            }}
            aria-label={t("openFiles")}
            title={t("openFiles")}
            aria-pressed={isDesktop ? filesPanelOpen : undefined}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-[1.8]" aria-hidden>
              <path
                d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => {
              markFreshDraftRequested();
              chatClient.connect(null, { force: true });
              void navigate({ to: "/" });
              chatClient.requestComposerFocus();
            }}
            aria-label={t("newSession")}
            title={t("newSession")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <NewSessionIcon />
          </button>
        </header>
        <SessionTabs />

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
              messages={[...(snapshot?.messages ?? []), ...optimisticMessages]}
              streamText={streamText}
              streamThinking={streamThinking}
              streamThinkingComplete={streamThinkingComplete}
              activeTools={activeTools}
              isStreaming={isStreaming}
              containerRef={messageListRef}
            />
            {updateAvailable && (
              <div
                role="status"
                className="flex shrink-0 items-start gap-3 border-t border-line bg-card px-4 py-2.5"
              >
                <div className="min-w-0 flex-1 text-xs text-muted">
                  <p className="font-medium text-ink">
                    {t("updateAvailable")}
                    {updateVersion ? ` · v${updateVersion}` : ""}
                  </p>
                  {updateNotes.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {updateNotes.map((note, index) => (
                        <li key={`${updateVersion ?? "update"}-${index}`} className="break-words">
                          {note}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
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
                  className="shrink-0 rounded-lg bg-accent px-3 py-1 text-xs font-medium text-accent-ink transition-opacity hover:opacity-90"
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
            <Composer
              key={activeTabKey}
              tabKey={activeTabKey}
              isStreaming={isStreaming}
              containerRef={messageListRef}
            />
          </>
        )}
        <ExtensionUIHost />
      </div>
      <FileWorkspaceSidebar />
      <FilesDrawer onPreviewFile={setMobilePreview} onSelectCommit={setMobileGitCommit} />
      {mobilePreview && (
        <MobileFilePreview
          selection={mobilePreview}
          theme={theme}
          locale={locale}
          onClose={() => setMobilePreview(null)}
        />
      )}
      {mobileGitCommit && (
        <MobileGitCommitDetail
          selection={mobileGitCommit}
          onClose={() => setMobileGitCommit(null)}
        />
      )}
    </div>
  );
}
