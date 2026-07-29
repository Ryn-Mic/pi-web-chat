import { useChat } from "../lib/chat";
import { requestOpenSessionsDrawer } from "../lib/drawer";
import { useT } from "../lib/i18n";
import { useSidebarPinned } from "../lib/sidebar";
import { useLeftEdgeSwipe } from "../lib/useEdgeSwipe";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ModelMenu } from "./ModelMenu";
import { SessionsDrawer, SessionsSidebar } from "./SessionsDrawer";
import { SettingsMenu } from "./SettingsMenu";
import { ThinkingMenu } from "./ThinkingMenu";

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
  const { connection, snapshot, streamText, streamThinking, activeTools } = useChat();
  const isStreaming = snapshot?.isStreaming ?? false;
  const sidebarPinned = useSidebarPinned();
  const showConnectingOverlay = connection !== "connected" && !snapshot;

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
          <ThinkingMenu
            current={snapshot?.thinkingLevel ?? "off"}
            levels={snapshot?.thinkingLevels ?? ["off"]}
          />
          <ModelMenu current={snapshot?.model ?? null} />
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
            <Composer isStreaming={isStreaming} />
          </>
        )}
      </div>
    </div>
  );
}
