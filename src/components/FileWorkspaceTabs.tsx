import { useEffect, useRef } from "react";
import {
  nextWorkspaceFocusAfterClose,
  nextWorkspaceTabId,
  shouldCloseWorkspaceTab,
  type WorkspaceNavigationKey,
} from "../lib/file-workspace-tabs";
import { previewIdentity, type PreviewWorkspaceState } from "../lib/file-preview";
import { useT } from "../lib/i18n";

const FILES_TAB_ID = "files";

export function workspacePanelId(tabKey: string, identity: string): string {
  return `file-workspace-panel-${encodeURIComponent(tabKey)}-${encodeURIComponent(identity)}`;
}

export function workspaceTabId(tabKey: string, identity: string): string {
  return `file-workspace-tab-${encodeURIComponent(tabKey)}-${encodeURIComponent(identity)}`;
}

export function FileWorkspaceTabs({
  tabKey,
  workspace,
  onActivate,
  onClose,
  onRefresh,
}: {
  tabKey: string;
  workspace: PreviewWorkspaceState;
  onActivate(identity: string): void;
  onClose(identity: string): void;
  onRefresh?: () => void;
}) {
  const t = useT();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabs = [
    { identity: FILES_TAB_ID, name: t("files"), title: t("files"), closeable: false },
    ...workspace.tabs.map((tab) => ({
      identity: previewIdentity(tab.cwd, tab.path),
      name: tab.name,
      title: `${tab.cwd.replace(/\/$/, "")}/${tab.path.replace(/^\//, "")}`,
      closeable: true,
    })),
  ];
  const ids = tabs.map((tab) => tab.identity);

  useEffect(() => {
    tabRefs.current.get(workspace.active)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [workspace.active]);

  const closeAndFocusNeighbor = (identity: string) => {
    const next = nextWorkspaceFocusAfterClose(ids, workspace.active, identity);
    onClose(identity);
    requestAnimationFrame(() => tabRefs.current.get(next)?.focus());
  };

  return (
    <div
      role="tablist"
      aria-label={t("files")}
      className="thin-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-sidebar px-2 py-1.5"
    >
      {tabs.map((tab) => {
        const selected = workspace.active === tab.identity;
        const tabElementId = workspaceTabId(tabKey, tab.identity);
        return (
          <div
            key={tab.identity}
            className={`group flex min-w-0 max-w-56 shrink-0 items-center rounded-md transition-colors ${
              selected
                ? "bg-card text-ink shadow-sm"
                : "text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            <button
              ref={(node) => {
                if (node) tabRefs.current.set(tab.identity, node);
                else tabRefs.current.delete(tab.identity);
              }}
              id={tabElementId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={workspacePanelId(tabKey, tab.identity)}
              tabIndex={selected ? 0 : -1}
              title={tab.title}
              onClick={() => onActivate(tab.identity)}
              onKeyDown={(event) => {
                const key = event.key as WorkspaceNavigationKey;
                if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
                  event.preventDefault();
                  const next = nextWorkspaceTabId(ids, tab.identity, key);
                  onActivate(next);
                  requestAnimationFrame(() => tabRefs.current.get(next)?.focus());
                  return;
                }
                if (tab.closeable && shouldCloseWorkspaceTab(event.key)) {
                  event.preventDefault();
                  closeAndFocusNeighbor(tab.identity);
                }
              }}
              className="min-w-0 truncate px-2.5 py-1.5 text-left text-xs"
            >
              {tab.name}
            </button>
            {tab.closeable && (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  closeAndFocusNeighbor(tab.identity);
                }}
                aria-label={`${t("closePreviewTab")}: ${tab.name}`}
                title={t("closePreviewTab")}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <span aria-hidden>×</span>
              </button>
            )}
          </div>
        );
      })}
      {workspace.active !== FILES_TAB_ID && onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          aria-label={t("refreshPreview")}
          title={t("refreshPreview")}
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.8]" aria-hidden>
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
