import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UITreeNode } from "../../shared/protocol";
import { useInvalidateTree, useTree } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { onRequestOpenFilesDrawer } from "../lib/drawer";
import {
  setFilesPanelOpen,
  toggleTreeDirExpanded,
  useFilesPanelOpen,
  useTreeDirExpanded,
} from "../lib/filetree";
import { useT } from "../lib/i18n";

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
  onPickFile,
}: {
  cwd: string;
  node: UITreeNode;
  depth: number;
  onPickFile?: () => void;
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
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] cursor-not-allowed text-faint transition-colors"
          >
            <span className="size-3 shrink-0" aria-hidden />
            {/* nf-fa-folder_o */}
            <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
              {"\uf114"}
            </span>
            <span className="truncate">{node.name}</span>
            <span className="sr-only">— {t("inaccessible")}</span>
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
            {/* nf-fa-folder_o / folder_open_o */}
            <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
              {expanded ? "\uf115" : "\uf114"}
            </span>
            <span className="truncate">{node.name}</span>
          </button>
          {expanded && <TreeDir cwd={cwd} path={node.path} depth={depth + 1} onPickFile={onPickFile} />}
        </div>
      );
    }

    // Empty dir (hasChildren === false): folder/name only, not an expandable action.
    return (
      <div
        style={indent}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] text-muted"
      >
        <span className="size-3 shrink-0" aria-hidden />
        {/* nf-fa-folder_o */}
        <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
          {"\uf114"}
        </span>
        <span className="truncate">{node.name}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      style={indent}
      onClick={() => {
        chatClient.insertComposerText(`@${node.path} `);
        onPickFile?.();
      }}
      title={node.path}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
    >
      <span className="size-3 shrink-0" aria-hidden />
      {/* nf-fa-file_o */}
      <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
        {"\uf016"}
      </span>
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function TreeDir({
  cwd,
  path,
  depth,
  onPickFile,
}: {
  cwd: string;
  path: string;
  depth: number;
  onPickFile?: () => void;
}) {
  const t = useT();
  const { data, isPending, isError, refetch } = useTree(cwd, path);
  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  if (isPending) {
    return (
      <div style={indent} className="py-1.5 text-[12px] text-faint" aria-busy>
        …
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
        <TreeNodeRow key={node.path} cwd={cwd} node={node} depth={depth} onPickFile={onPickFile} />
      ))}
      {data?.truncated && (
        <div style={indent} className="py-1.5 text-[11px] text-faint">
          {t("treeTruncated")}
        </div>
      )}
    </>
  );
}

/** Shared tree content (desktop sidebar + mobile drawer), rooted at the active tab's cwd. */
export function FileTreePanel({ onClose, onPickFile }: { onClose?: () => void; onPickFile?: () => void }) {
  const t = useT();
  const { snapshot } = useChat();
  const cwd = snapshot?.cwd;
  const invalidateTree = useInvalidateTree();
  const rootQuery = useTree(cwd, "", !!cwd);

  return (
    <>
      <div className="flex items-center justify-between gap-1 px-3 py-2.5 pt-[calc(0.75rem+env(safe-area-inset-top))] md:pt-2.5">
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold tracking-tight text-ink" title={cwd}>
          {rootQuery.data?.root ?? t("files")}
        </h2>
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
          <TreeDir cwd={cwd} path="" depth={0} onPickFile={onPickFile} />
        ) : (
          <div className="px-4 py-8 text-center text-sm text-faint">{t("emptyDirectory")}</div>
        )}
      </div>
    </>
  );
}

/** Desktop docked right panel (md+), controlled by the header toggle. */
export function FilesSidebar() {
  const open = useFilesPanelOpen();
  if (!open) return null;
  return (
    <aside className="hidden h-full min-h-0 w-64 shrink-0 flex-col overflow-hidden bg-sidebar md:flex">
      <FileTreePanel onClose={() => setFilesPanelOpen(false)} />
    </aside>
  );
}

/** Mobile right-edge overlay drawer. */
export function FilesDrawer() {
  const [open, setOpen] = useState(false);
  useEffect(() => onRequestOpenFilesDrawer(() => setOpen(true)), []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full">
          <FileTreePanel onClose={() => setOpen(false)} onPickFile={() => setOpen(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
