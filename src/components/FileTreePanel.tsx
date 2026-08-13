import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState, type MouseEvent } from "react";
import type { UITreeNode } from "../../shared/protocol";
import { useInvalidateTree, useTree } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenFilesDrawer } from "../lib/drawer";
import { previewIdentity } from "../lib/file-preview";
import { toggleTreeDirExpanded, useTreeDirExpanded } from "../lib/filetree";
import { useT } from "../lib/i18n";
import { GitWorkspacePanel } from "./GitWorkspacePanel";

export interface PreviewFileSelection {
  cwd: string;
  path: string;
  name: string;
  trigger?: HTMLElement | null;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-3 shrink-0 fill-none stroke-current stroke-2 transition-transform ${expanded ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
            <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
              {expanded ? "\uf115" : "\uf114"}
            </span>
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
        className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-[13px]"
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
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-xs font-medium text-faint transition-colors hover:bg-hover hover:text-ink"
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
      <div style={indent} className="py-1.5 text-[12px] text-faint" aria-busy>
        ...
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

/** Shared tree content, rooted at the active chat tab's project directory. */
export function FileTreePanel({
  docked,
  onClose,
  onPickFile,
  onPreviewFile,
  selectedFileIdentity,
  cwd: cwdOverride,
}: {
  docked?: boolean;
  onClose?: () => void;
  onPickFile?: () => void;
  onPreviewFile?: (file: PreviewFileSelection) => void;
  selectedFileIdentity?: string;
  cwd?: string;
}) {
  const t = useT();
  const { snapshot } = useChat();
  const cwd = cwdOverride ?? snapshot?.cwd;
  const invalidateTree = useInvalidateTree();
  const rootQuery = useTree(cwd, "", !!cwd);

  return (
    <>
      <div className="flex items-center justify-between gap-1 px-3 py-2.5 pt-[calc(0.75rem+env(safe-area-inset-top))] md:pt-2.5">
        {docked ? (
          <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold tracking-tight text-ink" title={cwd}>
            {rootQuery.data?.root ?? t("files")}
          </h2>
        ) : (
          <Dialog.Title className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold tracking-tight text-ink" title={cwd}>
            {rootQuery.data?.root ?? t("files")}
          </Dialog.Title>
        )}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => cwd && invalidateTree(cwd)}
            title={t("refreshTree")}
            aria-label={t("refreshTree")}
            className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.8]" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t("closeFiles")}
              aria-label={t("closeFiles")}
              className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {cwd ? (
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
    </>
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
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"files" | "git">("files");
  useEffect(() => onRequestOpenFilesDrawer((nextView) => {
    if (nextView) setView(nextView);
    setOpen(true);
  }), []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full">
          <Dialog.Title className="sr-only">{t("workspace")}</Dialog.Title>
          <div role="tablist" aria-label={t("workspace")} className="flex shrink-0 gap-1 border-b border-line px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-1.5">
            {(["files", "git"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={view === item}
                onClick={() => setView(item)}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${view === item ? "bg-card text-ink shadow-sm" : "text-muted hover:bg-hover hover:text-ink"}`}
              >
                {t(item)}
              </button>
            ))}
          </div>
          {view === "files" ? (
            <FileTreePanel
              onClose={() => setOpen(false)}
              onPickFile={() => setOpen(false)}
              onPreviewFile={onPreviewFile}
            />
          ) : (
            <GitWorkspacePanel
              cwd={snapshot?.cwd}
              docked={false}
              onClose={() => setOpen(false)}
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
