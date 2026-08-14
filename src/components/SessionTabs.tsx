import { useNavigate } from "@tanstack/react-router";
import { activityDotClass, connectionActivity } from "../lib/activity";
import { chatClient, useChatTabs, type ChatTab } from "../lib/chat";
import { useT } from "../lib/i18n";
import { markFreshDraftRequested } from "../lib/resume";

function firstUserText(tab: ChatTab): string | null {
  const message = tab.state.snapshot?.messages.find((item) => item.role === "user");
  if (!message) return null;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text ? text.slice(0, 32) : null;
}

function tabTitle(tab: ChatTab, newSessionLabel: string): string {
  if (!tab.sessionId) return newSessionLabel;
  return firstUserText(tab) ?? `#${tab.sessionId.slice(0, 8)}`;
}

function selectTab(tab: ChatTab, navigate: ReturnType<typeof useNavigate>) {
  chatClient.activate(tab.key);
  if (tab.sessionId) {
    void navigate({ to: "/s/$sessionId", params: { sessionId: tab.sessionId }, replace: true });
  } else {
    markFreshDraftRequested();
    void navigate({ to: "/", replace: true });
  }
}

export function SessionTabs() {
  const tabs = useChatTabs();
  const activeKey = chatClient.activeTabKey;
  const navigate = useNavigate();
  const t = useT();

  if (tabs.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label={t("sessions")}
      className="thin-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2.5 pb-1"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const title = tabTitle(tab, t("newSession"));
        const running = tab.state.snapshot?.isStreaming;
        return (
          <div
            key={tab.key}
            className={`group flex min-w-0 max-w-52 shrink-0 items-center rounded-lg border transition-colors ${
              active
                ? "border-line bg-card text-ink shadow-sm"
                : "border-transparent text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(tab, navigate)}
              title={title}
              className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${activityDotClass(
                  connectionActivity(tab.state.connection, Boolean(running)),
                )}`}
                aria-hidden
              />
              <span className="truncate">{title}</span>
            </button>
            <button
              type="button"
              aria-label={`${t("closeSessionTab")}: ${title}`}
              title={t("closeSessionTab")}
              onClick={() => {
                const wasActive = tab.key === activeKey;
                const next = chatClient.closeTab(tab.key);
                if (wasActive) {
                  if (next?.sessionId) {
                    void navigate({
                      to: "/s/$sessionId",
                      params: { sessionId: next.sessionId },
                      replace: true,
                    });
                  } else {
                    void navigate({ to: "/", replace: true });
                  }
                }
              }}
              className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
