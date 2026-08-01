import { Dialog } from "@base-ui-components/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { UISessionInfo } from "../../shared/protocol";
import { useInvalidateSessions, useSessions } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenSessionsDrawer } from "../lib/drawer";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { setSidebarPinned, useSidebarPinned } from "../lib/sidebar";

function formatDate(iso: string, locale: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(locale, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
  );
}

/** 사이드바 토글 아이콘 (Claude/ChatGPT desktop 스타일 패널 아이콘) */
function SidebarPanelIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-[1.8]">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current stroke-[1.8]">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 shrink-0 fill-none stroke-current stroke-[1.6] opacity-70"
    >
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1-5.2A8 8 0 1 1 21 12Z" strokeLinejoin="round" />
    </svg>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: UISessionInfo;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const title = session.name ?? session.firstMessage ?? t("emptySession");
  const meta = `${formatDate(session.modified, localeTag(locale))} · ${t("messageCount", {
    count: session.messageCount,
  })}`;
  return (
    <button
      onClick={onSelect}
      title={`${title}\n${meta}`}
      className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
        active ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink"
      }`}
    >
      <ChatIcon />
      <span className="truncate text-[13.5px]">{title}</span>
    </button>
  );
}

/** sessionFile 변경·스트리밍 종료 시 목록 갱신 */
function useSessionListSync(enabled: boolean) {
  const invalidate = useInvalidateSessions();
  const { snapshot } = useChat();
  const sessionFile = snapshot?.sessionFile;
  const isStreaming = snapshot?.isStreaming ?? false;
  const prevStreaming = useRef(isStreaming);

  // 세션 파일 바뀜 (new/switch/fork)
  useEffect(() => {
    if (!enabled || !sessionFile) return;
    void invalidate();
  }, [enabled, sessionFile, invalidate]);

  // 응답 끝나면 firstMessage/messageCount 반영
  useEffect(() => {
    if (!enabled) {
      prevStreaming.current = isStreaming;
      return;
    }
    if (prevStreaming.current && !isStreaming) {
      void invalidate();
    }
    prevStreaming.current = isStreaming;
  }, [enabled, isStreaming, invalidate]);
}

function SessionsPanel({
  currentSessionFile,
  docked,
  active = true,
  onSelectSession,
  onClose,
  onDock,
}: {
  currentSessionFile?: string;
  docked?: boolean;
  /** false면 fetch 중지 (닫힌 드로어) */
  active?: boolean;
  onSelectSession?: () => void;
  onClose?: () => void;
  /** 드로어 → 고정 전환 (닫힘 애니메이션 없이) */
  onDock?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const sidebarPinned = useSidebarPinned();
  const { data: sessions, refetch } = useSessions(active);
  useSessionListSync(active);

  // 패널이 활성화될 때마다 최신화 (드로어 오픈 / 독 마운트)
  useEffect(() => {
    if (active) void refetch();
  }, [active, refetch]);

  const toggleDock = () => {
    if (sidebarPinned) {
      setSidebarPinned(false);
      return;
    }
    // 드로어에서 고정: 부모에서 애니메이션 없이 전환
    if (onDock) onDock();
    else setSidebarPinned(true);
  };

  const startNewSession = () => {
    // "/" 초안 화면. 이미 / 에 있어도 force 로 새 초안 WS를 연다.
    // 세션 id는 첫 메시지 때 서버가 내려주고 /s/:id 로 교체된다.
    void navigate({ to: "/" });
    chatClient.connect(null, { force: true });
    window.setTimeout(() => void refetch(), 150);
    onClose?.();
    chatClient.requestComposerFocus();
  };

  return (
    <>
      <div
        className={`flex items-center justify-between gap-1 px-3 py-2.5 ${
          docked ? "pt-2.5" : "pt-[calc(0.75rem+env(safe-area-inset-top))]"
        }`}
      >
        {docked ? (
          <h2 className="px-1 text-[15px] font-semibold tracking-tight text-ink">pi</h2>
        ) : (
          <Dialog.Title className="px-1 text-[15px] font-semibold tracking-tight text-ink">
            {t("sessions")}
          </Dialog.Title>
        )}
        <div className="flex items-center gap-1">
          {/* 데스크톱에서만 사이드바 고정 토글 */}
          <button
            type="button"
            onClick={toggleDock}
            title={sidebarPinned ? t("closeSidebar") : t("pinSidebar")}
            aria-label={sidebarPinned ? t("closeSidebar") : t("pinSidebar")}
            aria-pressed={sidebarPinned}
            className="hidden size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink md:flex"
          >
            <SidebarPanelIcon />
          </button>
        </div>
      </div>

      <div className="px-2 pb-1">
        <button
          onClick={startNewSession}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium text-accent transition-colors hover:bg-hover"
        >
          <PlusIcon />
          {t("newSession")}
        </button>
      </div>

      <div className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
        {t("sessions")}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {(sessions ?? []).map((s) => (
          <SessionRow
            key={s.path}
            session={s}
            active={s.path === currentSessionFile}
            onSelect={() => {
              void navigate({ to: "/s/$sessionId", params: { sessionId: s.id } });
              onSelectSession?.();
            }}
          />
        ))}
        {sessions && sessions.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-faint">{t("noSavedSessions")}</div>
        )}
      </div>
    </>
  );
}

/** 데스크톱 고정 사이드바 */
export function SessionsSidebar({ currentSessionFile }: { currentSessionFile?: string }) {
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col overflow-hidden bg-sidebar md:flex">
      <SessionsPanel currentSessionFile={currentSessionFile} docked active />
    </aside>
  );
}

/** 오버레이 드로어 (모바일 / 고정 해제 상태) */
export function SessionsDrawer({ currentSessionFile }: { currentSessionFile?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** 핀 고정 전환 시 true → Portal을 즉시 제거해 닫힘 애니 스킵 */
  const [instantHide, setInstantHide] = useState(false);
  const sidebarPinned = useSidebarPinned();

  const dockFromDrawer = () => {
    setInstantHide(true);
    setSidebarPinned(true);
    setOpen(false);
  };

  // 엣지 스와이프 등 외부 요청으로 드로어 열기
  useEffect(() => {
    return onRequestOpenSessionsDrawer(() => {
      if (sidebarPinned) return; // 고정 사이드바 상태면 무시
      setInstantHide(false);
      setOpen(true);
    });
  }, [sidebarPinned]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setInstantHide(false);
        setOpen(next);
      }}
    >
      <Dialog.Trigger
        className={`flex size-9 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink ${
          sidebarPinned ? "md:hidden" : ""
        }`}
        aria-label={t("sessionList")}
      >
        <SidebarPanelIcon />
      </Dialog.Trigger>
      {!instantHide && (
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
          <Dialog.Popup className="fixed inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full">
            <SessionsPanel
              currentSessionFile={currentSessionFile}
              active={open}
              onSelectSession={() => setOpen(false)}
              onClose={() => setOpen(false)}
              onDock={dockFromDrawer}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
