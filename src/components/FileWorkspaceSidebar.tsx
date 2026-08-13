import { useCallback, useState } from "react";
import { useInvalidateGit } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import {
  activatePreview,
  closePreview,
  openPreview,
  previewIdentity,
  showFilesTab,
  usePreviewWorkspace,
} from "../lib/file-preview";
import { setFilesPanelOpen, useFilesPanelOpen } from "../lib/filetree";
import { FilePreviewPane } from "./FilePreviewPane";
import {
  FileTreePanel,
  type PreviewFileSelection,
} from "./FileTreePanel";
import {
  FileWorkspaceTabs,
  workspacePanelId,
  workspaceTabId,
  FILES_TAB_ID,
  GIT_TAB_ID,
} from "./FileWorkspaceTabs";
import { GitWorkspacePanel } from "./GitWorkspacePanel";

export function openWorkspacePreview(file: PreviewFileSelection): void {
  const tabKey = chatClient.activeTabKey;
  if (!tabKey) return;
  setFilesPanelOpen(true);
  openPreview(tabKey, file.cwd, file.path, file.name);
}

export function FileWorkspaceSidebar() {
  const open = useFilesPanelOpen();
  const { snapshot } = useChat();
  const tabKey = chatClient.activeTabKey ?? "unbound";
  const workspace = usePreviewWorkspace(tabKey);
  const invalidateGit = useInvalidateGit();
  const [refreshByIdentity, setRefreshByIdentity] = useState<Record<string, number>>({});
  const activeTab = workspace.tabs.find(
    (tab) => previewIdentity(tab.cwd, tab.path) === workspace.active,
  );
  const selectedFileIdentity = activeTab
    ? previewIdentity(activeTab.cwd, activeTab.path)
    : undefined;

  const handlePreviewFile = useCallback((file: PreviewFileSelection) => {
    openWorkspacePreview(file);
  }, []);

  if (!open) return null;

  const activeIdentity = activeTab
    ? previewIdentity(activeTab.cwd, activeTab.path)
    : "files";
  const refresh = () => {
    if (workspace.active === GIT_TAB_ID) {
      if (snapshot?.cwd) invalidateGit(snapshot.cwd);
      return;
    }
    if (!activeTab) return;
    setRefreshByIdentity((current) => ({
      ...current,
      [activeIdentity]: (current[activeIdentity] ?? 0) + 1,
    }));
  };

  return (
    <aside
      className={`hidden h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-line bg-sidebar md:flex ${
        activeTab || workspace.active === GIT_TAB_ID ? "md:w-[22rem] lg:w-[min(46vw,48rem)]" : "md:w-64"
      }`}
    >
      <FileWorkspaceTabs
        tabKey={tabKey}
        workspace={workspace}
        onActivate={(identity) => {
          if (identity === FILES_TAB_ID) showFilesTab(tabKey);
          else if (identity === GIT_TAB_ID) activatePreview(tabKey, GIT_TAB_ID);
          else activatePreview(tabKey, identity);
        }}
        onClose={(identity) => closePreview(tabKey, identity)}
        onRefresh={refresh}
      />

      <div
        id={workspacePanelId(tabKey, FILES_TAB_ID)}
        role="tabpanel"
        aria-labelledby={workspaceTabId(tabKey, FILES_TAB_ID)}
        hidden={workspace.active !== FILES_TAB_ID}
        className="min-h-0 flex-1 flex-col data-[active=true]:flex"
        data-active={workspace.active === FILES_TAB_ID}
      >
        {workspace.active === FILES_TAB_ID && (
          <FileTreePanel
            docked
            onClose={() => setFilesPanelOpen(false)}
            onPreviewFile={handlePreviewFile}
            selectedFileIdentity={selectedFileIdentity}
            cwd={snapshot?.cwd}
          />
        )}
      </div>

      <div
        id={workspacePanelId(tabKey, GIT_TAB_ID)}
        role="tabpanel"
        aria-labelledby={workspaceTabId(tabKey, GIT_TAB_ID)}
        hidden={workspace.active !== GIT_TAB_ID}
        className="min-h-0 flex-1"
      >
        {workspace.active === GIT_TAB_ID && (
          <GitWorkspacePanel cwd={snapshot?.cwd} onPreviewFile={(file) => openWorkspacePreview({ ...file, cwd: file.cwd || snapshot?.cwd || "" })} onClose={() => setFilesPanelOpen(false)} />
        )}
      </div>

      {workspace.tabs.map((tab) => {
        const identity = previewIdentity(tab.cwd, tab.path);
        const active = identity === workspace.active;
        return (
          <div
            key={identity}
            id={workspacePanelId(tabKey, identity)}
            role="tabpanel"
            aria-labelledby={workspaceTabId(tabKey, identity)}
            hidden={!active}
            className="min-h-0 flex-1"
          >
            {active && (
              <FilePreviewPane
                cwd={tab.cwd}
                path={tab.path}
                name={tab.name}
                refreshToken={refreshByIdentity[identity] ?? 0}
              />
            )}
          </div>
        );
      })}
    </aside>
  );
}
