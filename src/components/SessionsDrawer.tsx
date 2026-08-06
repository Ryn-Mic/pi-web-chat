import { Dialog } from "@base-ui-components/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UISessionInfo } from "../../shared/protocol";
import { deleteSession, renameSession, useInvalidateSessions, useSessions } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenSessionsDrawer } from "../lib/drawer";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { suppressResumeOnce } from "../lib/resume";
import {
  setSidebarPinned,
  toggleProjectCollapsed,
  useProjectCollapsed,
  useSidebarPinned,
} from "../lib/sidebar";

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

function PlusIcon({ className = "size-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} fill-none stroke-current stroke-[1.8]`}>
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

/** 프로젝트 경로 → 표시용 마지막 디렉토리 이름 ("~/foo/bar" → "bar", "~" → "~") */
function projectDisplay(project: string): string {
  if (!project || project === "~") return project;
  const parts = project.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? project;
}

/** 프로젝트 그룹 헤더: 접기/펼치기 + 새 세션 버튼 */
function ProjectHeader({
  project,
  sessionCount,
  onNewSession,
}: {
  project: string;
  sessionCount: number;
  onNewSession: () => void;
}) {
  const t = useT();
  const collapsed = useProjectCollapsed(project);
  // "~" 또는 "/" 로 시작하는 실제 경로 그룹에만 새 세션 버튼 (인코딩된 폴백 이름 제외)
  const canCreate = project.startsWith("~") || project.startsWith("/");
  return (
    <div className="group flex items-center gap-0.5 py-1">
      <button
        type="button"
        onClick={() => toggleProjectCollapsed(project)}
        title={project}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] font-medium tracking-wide text-faint transition-colors hover:bg-hover hover:text-ink"
      >
        <svg
          viewBox="0 0 24 24"
          className={`size-3 shrink-0 fill-none stroke-current stroke-2 transition-transform ${
            collapsed ? "" : "rotate-90"
          }`}
        >
          <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate">{projectDisplay(project)}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums opacity-70">{sessionCount}</span>
      </button>
      {canCreate && (
        <button
          type="button"
          onClick={onNewSession}
          title={t("newSessionInProject")}
          aria-label={t("newSessionInProject")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: UISessionInfo;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const renameSubmitted = useRef(false);
  const title = session.name ?? session.firstMessage ?? t("emptySession");
  const meta = `${formatDate(session.modified, localeTag(locale))} · ${t("messageCount", {
    count: session.messageCount,
  })}`;

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg px-2 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              renameSubmitted.current = true;
              onRename(draft.trim());
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (renameSubmitted.current) {
              renameSubmitted.current = false;
              return;
            }
            onRename(draft.trim());
            setEditing(false);
          }}
          placeholder={t("sessionNamePlaceholder")}
          aria-label={t("renameSession")}
          className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-[13.5px] text-ink outline-none placeholder:text-faint"
        />
      </div>
    );
  }

  return (
    <div
      className={`group relative flex w-full items-center rounded-lg transition-colors ${
        active ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        title={`${title}\n${meta}`}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2.5 text-left"
      >
        <ChatIcon />
        <span
          className={`truncate text-[13.5px] ${active ? "text-ink" : "text-muted group-hover:text-ink"}`}
        >
          {title}
        </span>
      </button>

      {confirming ? (
        <span className="flex shrink-0 items-center gap-0.5 pr-1">
          <button
            type="button"
            onClick={onDelete}
            title={t("confirmDelete")}
            aria-label={t("confirmDelete")}
            className="flex size-6 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-red-500/10"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
              <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            title={t("cancel")}
            aria-label={t("cancel")}
            className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ) : (
        <span
          className={`flex shrink-0 items-center gap-0.5 pr-1 transition-opacity ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setDraft(session.name ?? session.firstMessage ?? "");
              setEditing(true);
            }}
            title={t("renameSession")}
            aria-label={t("renameSession")}
            className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.8]">
              <path
                d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title={t("deleteSession")}
            aria-label={t("deleteSession")}
            className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-red-500"
          >
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.8]">
              <path
                d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </span>
      )}
    </div>
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

/** 프로젝트 그룹: 헤더(접기/+/카운트) + 펼쳐졌을 때 세션 목록 */
function ProjectGroup({
  project,
  list,
  currentSessionFile,
  onSelect,
  onRename,
  onDelete,
  onNewSession,
}: {
  project: string;
  list: UISessionInfo[];
  currentSessionFile?: string;
  onSelect: (s: UISessionInfo) => void;
  onRename: (s: UISessionInfo, name: string) => void;
  onDelete: (s: UISessionInfo) => void;
  onNewSession: () => void;
}) {
  const collapsed = useProjectCollapsed(project);
  return (
    <div className="mb-0.5">
      <ProjectHeader project={project} sessionCount={list.length} onNewSession={onNewSession} />
      {!collapsed &&
        list.map((s) => (
          <SessionRow
            key={s.path}
            session={s}
            active={s.path === currentSessionFile}
            onSelect={() => onSelect(s)}
            onRename={(name) => onRename(s, name)}
            onDelete={() => onDelete(s)}
          />
        ))}
    </div>
  );
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
    suppressResumeOnce(); // resume 리다이렉트 방지 (마지막 세션으로 튀지 않게)
    void navigate({ to: "/" });
    chatClient.connect(null, { force: true });
    window.setTimeout(() => void refetch(), 150);
    onClose?.();
    chatClient.requestComposerFocus();
  };

  /** 특정 프로젝트 디렉토리에 새 세션 (서버가 ~ 확장) */
  const startNewSessionInProject = (project: string) => {
    if (!project || !(project.startsWith("~") || project.startsWith("/"))) return;
    suppressResumeOnce(); // resume 리다이렉트 방지 (마지막 세션으로 튀지 않게)
    void navigate({ to: "/" });
    chatClient.connect(null, { force: true, cwd: project });
    window.setTimeout(() => void refetch(), 150);
    onClose?.();
    chatClient.requestComposerFocus();
  };

  const handleDelete = async (session: UISessionInfo) => {
    try {
      await deleteSession(session.id);
    } catch {
      return;
    }
    void refetch();
    // 현재 보고 있는 세션을 지웠으면 새 초안으로 이동
    if (session.path === currentSessionFile) {
      suppressResumeOnce(); // 지운 세션으로 resume 리다이렉트되지 않게
      void navigate({ to: "/" });
      chatClient.connect(null, { force: true });
    }
  };

  const handleRename = async (session: UISessionInfo, name: string) => {
    if (name === (session.name ?? "")) return;
    try {
      await renameSession(session.id, name);
    } catch {
      /* ignore */
    }
    void refetch();
  };

  // 세션을 프로젝트별로 그룹핑 (서버 정렬: 최신순, 그룹 순서도 가장 최근 세션 기준으로 유지됨)
  const groups = useMemo(() => {
    const map = new Map<string, UISessionInfo[]>();
    for (const s of sessions ?? []) {
      const key = s.project || t("noProject");
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return Array.from(map.entries());
  }, [sessions, t]);

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
          type="button"
          onClick={startNewSession}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium text-accent transition-colors hover:bg-hover"
        >
          <PlusIcon />
          {t("newSession")}
        </button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {groups.map(([project, list]) => (
          <ProjectGroup
            key={project}
            project={project}
            list={list}
            currentSessionFile={currentSessionFile}
            onNewSession={() => startNewSessionInProject(project)}
            onSelect={(s) => {
              void navigate({ to: "/s/$sessionId", params: { sessionId: s.id } });
              onSelectSession?.();
            }}
            onRename={handleRename}
            onDelete={(s) => void handleDelete(s)}
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
