import { useCallback, useState } from "react";
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
import { FileWorkspaceTabs, workspacePanelId } from "./FileWorkspaceTabs";

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
    if (!activeTab) return;
    setRefreshByIdentity((current) => ({
      ...current,
      [activeIdentity]: (current[activeIdentity] ?? 0) + 1,
    }));
  };

  return (
    <aside
      className={`hidden h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-line bg-sidebar md:flex ${
        activeTab ? "md:w-[22rem] lg:w-[min(46vw,48rem)]" : "md:w-64"
      }`}
    >
      <FileWorkspaceTabs
        tabKey={tabKey}
        workspace={workspace}
        onActivate={(identity) => {
          if (identity === "files") showFilesTab(tabKey);
          else activatePreview(tabKey, identity);
        }}
        onClose={(identity) => closePreview(tabKey, identity)}
        onRefresh={refresh}
      />
      {activeTab ? (
        <div
          id={workspacePanelId(tabKey, activeIdentity)}
          role="tabpanel"
          aria-labelledby={`file-workspace-tab-${encodeURIComponent(tabKey)}-${encodeURIComponent(activeIdentity)}`}
          className="min-h-0 flex-1"
        >
          <FilePreviewPane
            cwd={activeTab.cwd}
            path={activeTab.path}
            name={activeTab.name}
            refreshToken={refreshByIdentity[activeIdentity] ?? 0}
          />
        </div>
      ) : (
        <div
          id={workspacePanelId(tabKey, "files")}
          role="tabpanel"
          aria-labelledby={`file-workspace-tab-${encodeURIComponent(tabKey)}-files`}
          className="flex min-h-0 flex-1 flex-col"
        >
          <FileTreePanel
            docked
            onClose={() => setFilesPanelOpen(false)}
            onPreviewFile={handlePreviewFile}
            selectedFileIdentity={selectedFileIdentity}
            cwd={snapshot?.cwd}
          />
        </div>
      )}
    </aside>
  );
}
