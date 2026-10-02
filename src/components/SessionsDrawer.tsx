import { Dialog } from "@base-ui-components/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UISessionInfo } from "../../shared/protocol";
import { deleteSession, renameSession, useInvalidateSessions, useSessions } from "../lib/api";
import { activityEyeState, activityEyeTone } from "../lib/activity";
import { getAgentPreference } from "../lib/agent";
import { chatClient, useChatField } from "../lib/chat";
import { onRequestOpenSessionsDrawer, setSessionsDrawerOpen } from "../lib/drawer";
import { formatRowDateTime } from "../lib/datetime-format";
import { localeTag, useLocale, useT } from "../lib/i18n";
import { confirmDiscardWorkspaceTextDrafts, discardWorkspaceTextDrafts } from "../lib/file-text-drafts";
import { markFreshDraftRequested } from "../lib/resume";
import {
  setSidebarPinned,
  toggleProjectCollapsed,
  useProjectCollapsed,
  useSidebarPinned,
} from "../lib/sidebar";
import { AgentEyes } from "./AgentEyes";
import { AgentIcon } from "./AgentIcon";
import { LoadingIndicator } from "./LoadingIndicator";
import { SettingsMenu } from "./SettingsMenu";
import { DIALOG_BACKDROP_CLASS } from "./ui";
import {
  ConfirmActionIcon,
  DeleteActionIcon,
  DismissActionIcon,
  FolderTreeIcon,
  NewSessionIcon,
  RenameActionIcon,
  SearchFieldIcon,
  SidebarToggleIcon,
  TreeChevronIcon,
} from "./MorphIcons";

/** Project path → display name (last directory segment; "~/foo/bar" → "bar", "~" → "~") */
function projectDisplay(project: string): string {
  if (!project || project === "~") return project;
  const parts = project.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? project;
}

/** Project group header: collapse/expand + new-session button */
function ProjectHeader({
  project,
  sessionCount,
  onNewSession,
  collapsed,
}: {
  project: string;
  sessionCount: number;
  onNewSession: () => void;
  collapsed: boolean;
}) {
  const t = useT();
  const [burstToken, setBurstToken] = useState(0);
  // Only real-path groups (starting with ~ or /) get a new-session button
  // (excludes encoded fallback names)
  const canCreate = project.startsWith("~") || project.startsWith("/");
  return (
    <div className="group flex items-center gap-0.5 py-1">
      <button
        type="button"
        onClick={() => toggleProjectCollapsed(project)}
        title={project}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-medium tracking-wide text-faint transition-colors hover:bg-hover hover:text-ink"
      >
        <TreeChevronIcon expanded={!collapsed} size={11} className="text-faint" />
        <FolderTreeIcon open={!collapsed} size={13} />
        <span className="truncate">{projectDisplay(project)}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums opacity-70">{sessionCount}</span>
      </button>
      {canCreate && (
        <button
          type="button"
          onClick={() => {
            setBurstToken((t) => t + 1);
            onNewSession();
          }}
          title={t("newSessionInProject")}
          aria-label={t("newSessionInProject")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <NewSessionIcon size={14} burstToken={burstToken} />
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
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const renameSubmitted = useRef(false);
  const title = session.name ?? session.firstMessage ?? t("emptySession");
  const agent = session.agent ?? "pi";
  const agentLabel = agent === "codex" ? t("agentCodex") : t("agentPi");
  const meta = `${formatRowDateTime(session.modified, localeTag(locale))} · ${t("messageCount", {
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
              setSaving(true);
              void onRename(draft.trim()).finally(() => setSaving(false));
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
            setSaving(true);
            void onRename(draft.trim()).finally(() => setSaving(false));
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
        active ? "bg-selected shadow-2xs" : "hover:bg-hover"
      }`}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-accent"
          aria-hidden
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        title={`${title}\n${meta}`}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2.5 text-left"
      >
        {/* Persisted sessions use neutral gray when idle and green while running. */}
        <AgentEyes
          state={activityEyeState(session.isStreaming ? "running" : "idle")}
          size={14}
          agent={agent}
          className={activityEyeTone(session.isStreaming ? "running" : "idle")}
        />
        <AgentIcon
          agent={agent}
          size={14}
          className={agent === "codex" ? "text-amber-500" : "text-faint"}
          title={agentLabel}
        />
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
            onClick={() => {
              setSaving(true);
              void onDelete().finally(() => setSaving(false));
            }}
            disabled={saving}
            title={t("confirmDelete")}
            aria-label={t("confirmDelete")}
            className="flex size-6 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-60"
          >
            {saving ? <LoadingIndicator label={t("loading")} size="sm" /> : (
              <ConfirmActionIcon />
            )}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            title={t("cancel")}
            aria-label={t("cancel")}
            className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <DismissActionIcon />
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
            <RenameActionIcon />
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title={t("deleteSession")}
            aria-label={t("deleteSession")}
            className="flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-red-500"
          >
            <DeleteActionIcon />
          </button>
        </span>
      )}
    </div>
  );
}

/** Refresh the list on sessionFile change and stream end */
function useSessionListSync(enabled: boolean) {
  const invalidate = useInvalidateSessions();
  const snapshot = useChatField("snapshot");
  const sessionFile = snapshot?.sessionFile;
  const isStreaming = snapshot?.isStreaming ?? false;
  const prevStreaming = useRef(isStreaming);

  // Session file changed (new/switch/fork)
  useEffect(() => {
    if (!enabled || !sessionFile) return;
    void invalidate();
  }, [enabled, sessionFile, invalidate]);

  // Refresh on streaming start/end so the running-state dot stays current
  useEffect(() => {
    if (!enabled) {
      prevStreaming.current = isStreaming;
      return;
    }
    if (prevStreaming.current !== isStreaming) void invalidate();
    prevStreaming.current = isStreaming;
  }, [enabled, isStreaming, invalidate]);
}

/** Project group: header (collapse/+/count) + session list when expanded */
function ProjectGroup({
  project,
  list,
  currentSessionFile,
  onSelect,
  onRename,
  onDelete,
  onNewSession,
  forceExpand = false,
}: {
  project: string;
  list: UISessionInfo[];
  currentSessionFile?: string;
  onSelect: (s: UISessionInfo) => void;
  onRename: (s: UISessionInfo, name: string) => Promise<void>;
  onDelete: (s: UISessionInfo) => Promise<void>;
  onNewSession: () => void;
  forceExpand?: boolean;
}) {
  const collapsed = useProjectCollapsed(project) && !forceExpand;
  return (
    <div className="mb-0.5">
      <ProjectHeader
        project={project}
        sessionCount={list.length}
        onNewSession={onNewSession}
        collapsed={collapsed}
      />
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
  settingsOpenToken = 0,
}: {
  currentSessionFile?: string;
  docked?: boolean;
  /** Stop fetching when false (closed drawer) */
  active?: boolean;
  onSelectSession?: () => void;
  onClose?: () => void;
  /** Drawer → docked transition (no close animation) */
  onDock?: () => void;
  settingsOpenToken?: number;
}) {
  const t = useT();
  const navigate = useNavigate();
  const sidebarPinned = useSidebarPinned();
  const [searchQuery, setSearchQuery] = useState("");
  const {
    data: sessions, isPending, isFetching, isError, refetch, scanning, showingCached,
    hasNextPage, fetchNextPage, isFetchingNextPage, partialFailure,
  } = useSessions(active, searchQuery);
  useSessionListSync(active);
  const activeSessionId = chatClient.state.sessionId;

  const toggleDock = () => {
    if (sidebarPinned) {
      setSidebarPinned(false);
      return;
    }
    // Dock from the drawer: switch in the parent without an animation
    if (onDock) onDock();
    else setSidebarPinned(true);
  };

  /** New session in a specific project directory (the server expands ~) */
  const startNewSessionInProject = (project: string) => {
    if (!project || !(project.startsWith("~") || project.startsWith("/"))) return;
    markFreshDraftRequested(); // don't resume-redirect back to the last session
    chatClient.connect(null, {
      force: true,
      cwd: project,
      agent: getAgentPreference() ?? undefined,
    });
    void navigate({ to: "/" });
    window.setTimeout(() => void refetch(), 150);
    onClose?.();
    chatClient.requestComposerFocus();
  };

  const handleDelete = async (session: UISessionInfo) => {
    const tab = chatClient.getTabsSnapshot().find((entry) => entry.sessionId === session.id);
    const workspaceKey = tab?.key ?? session.id;
    if (!confirmDiscardWorkspaceTextDrafts(workspaceKey, t("fileEditDiscardWorkspace"), false)) return;
    try {
      await deleteSession(session.id);
    } catch {
      return;
    }
    discardWorkspaceTextDrafts(workspaceKey);
    await refetch();
    const deletingActiveSession =
      session.id === activeSessionId || session.path === currentSessionFile;
    const nextTab = chatClient.closeTab(session.id);
    // If we deleted the session we're viewing, activate the next tab or create
    // a fresh draft instead of reconnecting the deleted session from the URL.
    if (deletingActiveSession) {
      markFreshDraftRequested(); // don't resume-redirect to the deleted session
      if (nextTab) {
        if (nextTab.sessionId) {
          void navigate({
            to: "/s/$sessionId",
            params: { sessionId: nextTab.sessionId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      } else {
        chatClient.connect(null, { force: true, agent: getAgentPreference() ?? undefined });
        void navigate({ to: "/", replace: true });
      }
    }
  };

  const handleRename = async (session: UISessionInfo, name: string) => {
    if (name === (session.name ?? "")) return;
    try {
      await renameSession(session.id, name);
    } catch {
      /* ignore */
    }
    await refetch();
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();

  // Group sessions by project (server sorts newest-first; group order follows
  // the most recent session too)
  const groups = useMemo(() => {
    const map = new Map<string, UISessionInfo[]>();
    for (const s of sessions ?? []) {
      if (normalizedQuery) {
        const matchName = s.name?.toLowerCase().includes(normalizedQuery);
        const matchFirst = s.firstMessage?.toLowerCase().includes(normalizedQuery);
        const matchProject = s.project?.toLowerCase().includes(normalizedQuery);
        const matchId = s.id.toLowerCase().includes(normalizedQuery);
        if (!matchName && !matchFirst && !matchProject && !matchId) continue;
      }
      const key = s.project || t("noProject");
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return Array.from(map.entries());
  }, [sessions, normalizedQuery, t]);

  const totalFilteredCount = useMemo(
    () => groups.reduce((acc, [, list]) => acc + list.length, 0),
    [groups],
  );

  return (
    <>
      <div
        className={`flex items-center justify-between gap-1 px-3 py-2.5 ${
          docked ? "pt-2.5" : "pt-[calc(0.75rem+env(safe-area-inset-top))]"
        }`}
      >
        {docked ? (
          <h2 className="px-1 text-[15px] font-semibold tracking-tight text-ink">{t("sessions")}</h2>
        ) : (
          <Dialog.Title className="px-1 text-[15px] font-semibold tracking-tight text-ink">
            {t("sessions")}
          </Dialog.Title>
        )}
        <div className="flex items-center gap-0.5">
          {isFetching && <LoadingIndicator label={t("loading")} size="sm" />}
          <SettingsMenu openToken={settingsOpenToken} />
          {/* Desktop-only sidebar dock toggle */}
          <button
            type="button"
            onClick={toggleDock}
            title={sidebarPinned ? t("closeSidebar") : t("pinSidebar")}
            aria-label={sidebarPinned ? t("closeSidebar") : t("pinSidebar")}
            aria-pressed={sidebarPinned}
            className="hidden size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink md:flex"
          >
            <SidebarToggleIcon open={sidebarPinned} size={18} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative flex items-center">
          <SearchFieldIcon className="pointer-events-none absolute left-2.5 text-faint" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchSessions")}
            className="w-full rounded-lg border border-line bg-card py-1.5 pr-7 pl-8 text-xs text-ink outline-none transition-colors placeholder:text-faint focus:border-accent/60"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              title={t("clearSearch")}
              aria-label={t("clearSearch")}
              className="absolute right-2 flex size-4 items-center justify-center rounded text-faint hover:text-ink"
            >
              <DismissActionIcon size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        className="thin-scroll flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        onScroll={(event) => {
          const target = event.currentTarget;
          if (hasNextPage && !isFetching && !isError && target.scrollHeight - target.scrollTop - target.clientHeight < 160) {
            void fetchNextPage({ cancelRefetch: false });
          }
        }}
      >
        {showingCached && (
          <p className="px-3 py-1 text-[11px] text-faint" role="status">{t("sessionCacheRefreshing")}</p>
        )}
        {isPending || (scanning && !sessions?.length) ? (
          <div className="flex justify-center px-4 py-8">
            <LoadingIndicator label={t("loading")} showLabel />
          </div>
        ) : (
          groups.map(([project, list]) => (
            <ProjectGroup
              key={project}
              project={project}
              list={list}
              forceExpand={Boolean(normalizedQuery)}
              currentSessionFile={currentSessionFile}
              onNewSession={() => startNewSessionInProject(project)}
              onSelect={(s) => {
                void navigate({ to: "/s/$sessionId", params: { sessionId: s.id } });
                onSelectSession?.();
              }}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ))
        )}
        {(isError || partialFailure) && (
          <div className="px-3 py-3 text-center text-xs text-faint" role="status">
            <p>{t("sessionsLoadFailed")}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="mt-2 rounded-md border border-line px-3 py-1.5 text-ink hover:bg-hover disabled:opacity-50"
            >{t("sessionsRetry")}</button>
          </div>
        )}
        {hasNextPage && (
          <button
            type="button"
            onClick={() => void fetchNextPage({ cancelRefetch: false })}
            disabled={isFetching}
            className="my-2 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs text-faint hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            {isFetchingNextPage ? <LoadingIndicator label={t("loading")} size="sm" /> : t("loadMoreSessions")}
          </button>
        )}
        {scanning && Boolean(sessions?.length) && (
          <div className="flex justify-center px-3 py-2"><LoadingIndicator label={t("sessionsDiscovering")} showLabel size="sm" /></div>
        )}
        {!isPending && !scanning && !isError && !partialFailure && sessions && sessions.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-faint">{t(normalizedQuery ? "noMatchingSessions" : "noSavedSessions")}</div>
        )}
        {!isPending && !scanning && !isError && !partialFailure && sessions && sessions.length > 0 && totalFilteredCount === 0 && (
          <div className="px-4 py-8 text-center text-xs text-faint">{t("noMatchingSessions")}</div>
        )}
      </div>
    </>
  );
}

/** Desktop docked sidebar */
export function SessionsSidebar({
  currentSessionFile,
  settingsOpenToken = 0,
}: {
  currentSessionFile?: string;
  settingsOpenToken?: number;
}) {
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col overflow-hidden bg-sidebar md:flex">
      <SessionsPanel
        currentSessionFile={currentSessionFile}
        settingsOpenToken={settingsOpenToken}
        docked
        active
      />
    </aside>
  );
}

/** Overlay drawer (mobile / unpinned state) */
export function SessionsDrawer({
  currentSessionFile,
  settingsOpenToken = 0,
}: {
  currentSessionFile?: string;
  settingsOpenToken?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  /** true during a pin switch → portal is removed immediately to skip the close animation */
  const [instantHide, setInstantHide] = useState(false);
  const sidebarPinned = useSidebarPinned();

  const dockFromDrawer = () => {
    setInstantHide(true);
    setSidebarPinned(true);
    setOpen(false);
  };

  // Open the drawer from external requests (edge swipe etc.)
  useEffect(() => {
    return onRequestOpenSessionsDrawer(() => {
      if (sidebarPinned) return; // ignore when the sidebar is docked
      setInstantHide(false);
      setOpen(true);
    });
  }, [sidebarPinned]);

  useEffect(() => {
    setSessionsDrawerOpen(open && !sidebarPinned);
    return () => setSessionsDrawerOpen(false);
  }, [open, sidebarPinned]);

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
        <SidebarToggleIcon size={18} />
      </Dialog.Trigger>
      {!instantHide && (
        <Dialog.Portal>
          <Dialog.Backdrop className={DIALOG_BACKDROP_CLASS} />
          <Dialog.Popup className="fixed inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full">
            <SessionsPanel
              currentSessionFile={currentSessionFile}
              settingsOpenToken={sidebarPinned ? 0 : settingsOpenToken}
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
