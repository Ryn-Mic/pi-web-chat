import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState, type MouseEvent } from "react";
import type { UIFileMatch, UITreeNode } from "../../shared/protocol";
import { useFileSearch, useInvalidateGit, useInvalidateTree, useTree } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenFilesDrawer } from "../lib/drawer";
import { previewIdentity } from "../lib/file-preview";
import {
  currentFileSearchMatches,
  revealTreeDir,
  toggleTreeDirExpanded,
  useTreeDirExpanded,
} from "../lib/filetree";
import { useT } from "../lib/i18n";
import { GitWorkspacePanel } from "./GitWorkspacePanel";
import { LoadingIndicator } from "./LoadingIndicator";
import {
  FolderTreeIcon,
  RefreshActionIcon,
  TreeChevronIcon,
} from "./MorphIcons";

export interface PreviewFileSelection {
  cwd: string;
  path: string;
  name: string;
  trigger?: HTMLElement | null;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return <TreeChevronIcon expanded={expanded} size={11} className="text-faint" />;
}

function TreeNodeRow({
  cwd,
  node,
  depth,
  onPreviewFile,
  onPickFile,
  selectedFileIdentity,
}: {
  cwd: string;
  node: UITreeNode;
  depth: number;
  onPreviewFile?: (file: PreviewFileSelection) => void;
  onPickFile?: () => void;
  selectedFileIdentity?: string;
}) {
  const t = useT();
  const expanded = useTreeDirExpanded(cwd, node.path);
  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  if (node.type === "dir") {
    const expandable = node.hasChildren === true;

    if (node.inaccessible) {
      return (
        <div>
          <button
            type="button"
            style={indent}
            aria-disabled="true"
            onClick={() => {
              // Inaccessible: no expansion or child fetch; aria-disabled keeps it focusable.
            }}
            title={t("inaccessible")}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] text-faint transition-colors cursor-not-allowed"
          >
            <span className="size-3 shrink-0" aria-hidden />
            <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
              {"\uf114"}
            </span>
            <span className="truncate">{node.name}</span>
            <span className="sr-only"> {t("inaccessible")}</span>
          </button>
        </div>
      );
    }

    if (expandable) {
      return (
        <div>
          <button
            type="button"
            style={indent}
            onClick={() => toggleTreeDirExpanded(cwd, node.path)}
            title={node.path}
            aria-expanded={expanded}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <ChevronIcon expanded={expanded} />
            <FolderTreeIcon open={expanded} size={14} />
            <span className="truncate">{node.name}</span>
          </button>
          {expanded && (
            <TreeDir
              cwd={cwd}
              path={node.path}
              depth={depth + 1}
              onPreviewFile={onPreviewFile}
              onPickFile={onPickFile}
              selectedFileIdentity={selectedFileIdentity}
            />
          )}
        </div>
      );
    }

    return (
      <div
        style={indent}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] text-muted"
      >
        <span className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
          {"\uf114"}
        </span>
        <span className="truncate">{node.name}</span>
      </div>
    );
  }

  const selected = selectedFileIdentity === previewIdentity(cwd, node.path);
  const previewOrReference = (event: MouseEvent<HTMLButtonElement>) => {
    const file = { cwd, path: node.path, name: node.name, trigger: event.currentTarget };
    if (onPreviewFile) onPreviewFile(file);
    else chatClient.insertComposerText(`@${node.path} `);
    onPickFile?.();
  };

  return (
    <div
      style={indent}
      className={`flex min-w-0 items-center rounded-md transition-colors ${
        selected ? "bg-hover text-ink" : "text-muted hover:bg-hover hover:text-ink"
      }`}
    >
      <button
        type="button"
        onClick={previewOrReference}
        title={node.path}
        aria-label={t("previewFile", { name: node.name })}
        aria-current={selected ? "true" : undefined}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-[13px]"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${selected ? "bg-accent" : "bg-transparent"}`} aria-hidden />
        <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
          {"\uf016"}
        </span>
        <span className="truncate">{node.name}</span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          chatClient.insertComposerText(`@${node.path} `);
          onPickFile?.();
        }}
        title={`@${node.path}`}
        aria-label={t("referenceFile", { name: node.name })}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-medium text-faint transition-colors hover:bg-hover hover:text-ink"
      >
        @
      </button>
    </div>
  );
}

function TreeDir({
  cwd,
  path,
  depth,
  onPreviewFile,
  onPickFile,
  selectedFileIdentity,
}: {
  cwd: string;
  path: string;
  depth: number;
  onPreviewFile?: (file: PreviewFileSelection) => void;
  onPickFile?: () => void;
  selectedFileIdentity?: string;
}) {
  const t = useT();
  const { data, isPending, isError, refetch } = useTree(cwd, path);
  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  if (isPending) {
    return (
      <div style={indent} className="py-1.5">
        <LoadingIndicator label={t("loading")} size="sm" showLabel />
      </div>
    );
  }
  if (isError) {
    return (
      <button
        type="button"
        style={indent}
        onClick={() => void refetch()}
        className="py-1.5 text-[12px] text-faint transition-colors hover:text-ink"
      >
        {t("treeLoadError")}
      </button>
    );
  }
  const nodes = data?.nodes ?? [];
  if (nodes.length === 0) {
    return (
      <div style={indent} className="py-1.5 text-[12px] text-faint">
        {t("emptyDirectory")}
      </div>
    );
  }
  return (
    <>
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.path}
          cwd={cwd}
          node={node}
          depth={depth}
          onPreviewFile={onPreviewFile}
          onPickFile={onPickFile}
          selectedFileIdentity={selectedFileIdentity}
        />
      ))}
      {data?.truncated && (
        <div style={indent} className="py-1.5 text-[11px] text-faint">
          {t("treeTruncated")}
        </div>
      )}
    </>
  );
}

function FileSearchResultRow({
  cwd,
  match,
  onPreviewFile,
  onPickFile,
  onRevealDirectory,
  selectedFileIdentity,
}: {
  cwd: string;
  match: UIFileMatch;
  onPreviewFile?: (file: PreviewFileSelection) => void;
  onPickFile?: () => void;
  onRevealDirectory: (path: string) => void;
  selectedFileIdentity?: string;
}) {
  const t = useT();
  const secondaryPath = match.path === match.name ? "" : match.path;

  if (match.type === "dir") {
    return (
      <button
        type="button"
        onClick={() => onRevealDirectory(match.path)}
        title={match.path}
        className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
      >
        <span className="size-3 shrink-0" aria-hidden />
        <FolderTreeIcon open={false} size={14} />
        <span className="shrink-0 truncate">{match.name}/</span>
        {secondaryPath && <span className="min-w-0 flex-1 truncate text-xs text-faint">{secondaryPath}</span>}
      </button>
    );
  }

  const selected = selectedFileIdentity === previewIdentity(cwd, match.path);
  const previewOrReference = (event: MouseEvent<HTMLButtonElement>) => {
    const file = { cwd, path: match.path, name: match.name, trigger: event.currentTarget };
    if (onPreviewFile) onPreviewFile(file);
    else chatClient.insertComposerText(`@${match.path} `);
    onPickFile?.();
  };

  return (
    <div
      className={`flex min-w-0 items-center rounded-md transition-colors ${
        selected ? "bg-hover text-ink" : "text-muted hover:bg-hover hover:text-ink"
      }`}
    >
      <button
        type="button"
        onClick={previewOrReference}
        title={match.path}
        aria-label={t("previewFile", { name: match.name })}
        aria-current={selected ? "true" : undefined}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-[13px]"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${selected ? "bg-accent" : "bg-transparent"}`} aria-hidden />
        <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
          {"\uf016"}
        </span>
        <span className="shrink-0 truncate">{match.name}</span>
        {secondaryPath && <span className="min-w-0 flex-1 truncate text-xs text-faint">{secondaryPath}</span>}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          chatClient.insertComposerText(`@${match.path} `);
          onPickFile?.();
        }}
        title={`@${match.path}`}
        aria-label={t("referenceFile", { name: match.name })}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-medium text-faint transition-colors hover:bg-hover hover:text-ink"
      >
        @
      </button>
    </div>
  );
}

function FileSearchResults({
  cwd,
  matches,
  loading,
  error,
  partial,
  onRetry,
  onPreviewFile,
  onPickFile,
  onRevealDirectory,
  selectedFileIdentity,
}: {
  cwd: string;
  matches: UIFileMatch[] | undefined;
  loading: boolean;
  error: boolean;
  partial?: boolean;
  onRetry: () => void;
  onPreviewFile?: (file: PreviewFileSelection) => void;
  onPickFile?: () => void;
  onRevealDirectory: (path: string) => void;
  selectedFileIdentity?: string;
}) {
  const t = useT();
  if (loading) {
    return (
      <div className="px-2 py-3">
        <LoadingIndicator label={t("loading")} size="sm" showLabel />
      </div>
    );
  }
  if (error) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="px-2 py-3 text-left text-[12px] text-faint transition-colors hover:text-ink"
      >
        {t("treeLoadError")}
      </button>
    );
  }
  if (matches?.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-faint">{t("noMatchingFiles")}</div>;
  }
  if (!matches) return null;

  return (
    <>
      {matches.map((match) => (
        <FileSearchResultRow
          key={`${match.type}:${match.path}`}
          cwd={cwd}
          match={match}
          onPreviewFile={onPreviewFile}
          onPickFile={onPickFile}
          onRevealDirectory={onRevealDirectory}
          selectedFileIdentity={selectedFileIdentity}
        />
      ))}
      {partial && <div className="px-2 py-1.5 text-[11px] text-faint">{t("mentionPartial")}</div>}
    </>
  );
}

/** Shared tree content, rooted at the active chat tab's project directory. */
export function FileTreePanel({
  onPickFile,
  onPreviewFile,
  selectedFileIdentity,
  cwd: cwdOverride,
}: {
  onPickFile?: () => void;
  onPreviewFile?: (file: PreviewFileSelection) => void;
  selectedFileIdentity?: string;
  cwd?: string;
}) {
  const t = useT();
  const { snapshot } = useChat();
  const cwd = cwdOverride ?? snapshot?.cwd;
  const [filterQuery, setFilterQuery] = useState("");
  const searchQuery = filterQuery.trim();
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  useEffect(() => {
    if (!searchQuery) {
      setDebouncedSearchQuery("");
      return;
    }
    const id = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 150);
    return () => window.clearTimeout(id);
  }, [searchQuery]);

  const searchReady = Boolean(searchQuery) && debouncedSearchQuery === searchQuery;
  const {
    data: searchData,
    isPending: searchPending,
    isFetching: searchFetching,
    isError: searchFailed,
    refetch: refetchSearch,
  } = useFileSearch(cwd, debouncedSearchQuery, searchReady);
  const searchMatches = currentFileSearchMatches(searchData, searchQuery);
  const searchLoading = Boolean(searchQuery) && (
    !searchReady || (searchMatches === undefined && (searchPending || searchFetching))
  );
  const clearSearch = () => {
    setFilterQuery("");
    setDebouncedSearchQuery("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pt-2 pb-1">
        <div className="relative flex items-center">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-2.5 size-3.5 fill-none stroke-current stroke-2 text-faint"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={t("searchFiles")}
            className="w-full rounded-lg border border-line bg-card py-1.5 pr-7 pl-8 text-xs text-ink outline-none transition-colors placeholder:text-faint focus:border-accent/60"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={clearSearch}
              title={t("clearSearch")}
              aria-label={t("clearSearch")}
              className="absolute right-2 flex size-4 items-center justify-center rounded text-faint hover:text-ink"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {cwd && searchQuery ? (
          <FileSearchResults
            cwd={cwd}
            matches={searchMatches}
            loading={searchLoading}
            error={searchReady && searchFailed && searchMatches === undefined}
            partial={searchMatches ? searchData?.partial : undefined}
            onRetry={() => void refetchSearch()}
            onPreviewFile={onPreviewFile}
            onPickFile={onPickFile}
            onRevealDirectory={(path) => {
              revealTreeDir(cwd, path);
              clearSearch();
            }}
            selectedFileIdentity={selectedFileIdentity}
          />
        ) : cwd ? (
          <TreeDir
            cwd={cwd}
            path=""
            depth={0}
            onPreviewFile={onPreviewFile}
            onPickFile={onPickFile}
            selectedFileIdentity={selectedFileIdentity}
          />
        ) : (
          <div className="px-4 py-8 text-center text-sm text-faint">{t("emptyDirectory")}</div>
        )}
      </div>
    </div>
  );
}

/** Mobile right-edge overlay drawer. */
export function FilesDrawer({
  onPreviewFile,
  onSelectCommit,
}: {
  onPreviewFile?: (file: PreviewFileSelection) => void;
  onSelectCommit?: (commit: { cwd: string; hash: string; subject: string; trigger?: HTMLElement | null }) => void;
}) {
  const t = useT();
  const { snapshot } = useChat();
  const invalidateGit = useInvalidateGit();
  const invalidateTree = useInvalidateTree();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"files" | "git">("files");
  useEffect(() => onRequestOpenFilesDrawer((nextView) => {
    if (nextView) setView(nextView);
    setOpen(true);
  }), []);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (!snapshot?.cwd) return;
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 750);
    if (view === "files") invalidateTree(snapshot.cwd);
    else invalidateGit(snapshot.cwd);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full">
          <Dialog.Title className="sr-only">{t("workspace")}</Dialog.Title>
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-1.5">
            <div role="tablist" aria-label={t("workspace")} className="flex min-w-0 flex-1 gap-1">
              {(["files", "git"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={view === item}
                  onClick={() => setView(item)}
                  className={`min-w-0 flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${view === item ? "bg-card text-ink shadow-sm" : "text-muted hover:bg-hover hover:text-ink"}`}
                >
                  {t(item)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={!snapshot?.cwd}
              aria-label={view === "files" ? t("refreshTree") : t("refreshPreview")}
              title={view === "files" ? t("refreshTree") : t("refreshPreview")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
            >
              <RefreshActionIcon refreshing={refreshing} size={16} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("closeFiles")}
              title={t("closeFiles")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {view === "files" ? (
            <FileTreePanel
              onPickFile={() => setOpen(false)}
              onPreviewFile={onPreviewFile}
            />
          ) : (
            <GitWorkspacePanel
              cwd={snapshot?.cwd}
              onSelectCommit={(commit, trigger) => {
                setOpen(false);
                onSelectCommit?.({ cwd: snapshot?.cwd ?? "", hash: commit.hash, subject: commit.subject, trigger });
              }}
              onPreviewFile={(file) => {
                setOpen(false);
                onPreviewFile?.({ ...file, cwd: file.cwd || snapshot?.cwd || "" });
              }}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
