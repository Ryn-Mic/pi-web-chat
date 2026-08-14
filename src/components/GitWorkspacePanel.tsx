import { useMemo, useState, type MouseEvent } from "react";
import type { UIGitBranch, UIGitCommit, UIGitCommitDetail, UIGitFile, UIGitStatus } from "../../shared/protocol";
import {
  checkoutGitBranch,
  useGitBranches,
  useGitCommit,
  useGitLog,
  useGitStatus,
} from "../lib/api";
import { chatClient } from "../lib/chat";
import { formatGitTimestamp, splitCommitDiffByFile } from "../lib/git";
import { useT } from "../lib/i18n";
import { DiffView } from "./DiffView";
import { LoadingIndicator } from "./LoadingIndicator";
import type { PreviewFileSelection } from "./FileTreePanel";

function statusLetter(file: UIGitFile): string {
  if (file.kind === "untracked") return "?";
  if (file.kind === "conflicted") return "!";
  if (file.kind === "renamed") return "R";
  if (file.kind === "added") return "A";
  if (file.kind === "deleted") return "D";
  return "M";
}

function statusClass(file: UIGitFile): string {
  if (file.kind === "conflicted") return "text-red-500";
  if (file.kind === "untracked") return "text-amber-500";
  if (file.kind === "added") return "text-emerald-500";
  if (file.kind === "deleted") return "text-red-500";
  return "text-accent";
}

function GitFileRow({
  cwd,
  file,
  onPreviewFile,
}: {
  cwd: string;
  file: UIGitFile;
  onPreviewFile?: (file: PreviewFileSelection) => void;
}) {
  const t = useT();
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const selected = {
      cwd,
      path: file.path,
      name: file.path.split("/").pop() ?? file.path,
      trigger: event.currentTarget,
    };
    if (onPreviewFile) onPreviewFile(selected);
    else chatClient.insertComposerText(`@${file.path} `);
  };
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-hover">
      <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px]" title={file.path}>
        <span className={`w-3 shrink-0 text-center font-mono font-semibold ${statusClass(file)}`} aria-hidden>{statusLetter(file)}</span>
        <span className="truncate text-muted">{file.path}</span>
      </button>
      <button
        type="button"
        onClick={() => chatClient.insertComposerText(`@${file.path} `)}
        aria-label={t("referenceFile", { name: file.path })}
        title={`@${file.path}`}
        className="flex size-7 shrink-0 items-center justify-center rounded text-[11px] text-faint hover:bg-hover hover:text-ink"
      >
        @
      </button>
    </div>
  );
}

function FileGroup({
  cwd,
  title,
  files,
  onPreviewFile,
}: {
  cwd: string;
  title: string;
  files: UIGitFile[];
  onPreviewFile?: (file: PreviewFileSelection) => void;
}) {
  if (files.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-faint">{title} <span className="font-normal">{files.length}</span></h3>
      <div>{files.map((file, index) => <GitFileRow key={`${file.path}-${file.oldPath ?? ""}-${index}`} cwd={cwd} file={file} onPreviewFile={onPreviewFile} />)}</div>
    </section>
  );
}

function BranchSection({ cwd, status, branches }: { cwd: string; status: UIGitStatus; branches: UIGitBranch[] }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const switchBranch = async (branch: string) => {
    if (branch === status.branch || switchingBranch) return;
    if (status.isDirty) {
      setError(t("gitConfirmDiscard"));
      return;
    }
    setError(null);
    setSwitchingBranch(branch);
    try {
      await checkoutGitBranch(cwd, branch);
      window.location.reload();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("gitOperationFailed"));
      setSwitchingBranch(null);
    }
  };
  return (
    <section className="space-y-1">
      <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-faint">{t("gitBranches")}</h3>
      <div className="space-y-0.5">
        {branches.map((branch) => (
          <button
            key={branch.name}
            type="button"
            disabled={switchingBranch !== null}
            onClick={() => void switchBranch(branch.name)}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-hover disabled:opacity-50 ${branch.current ? "text-ink" : "text-muted"}`}
            title={branch.upstream ? `${branch.name} -> ${branch.upstream}` : branch.name}
          >
            {switchingBranch === branch.name ? (
              <LoadingIndicator label={t("loading")} size="sm" />
            ) : (
              <span className={`size-1.5 shrink-0 rounded-full ${branch.current ? "bg-emerald-500" : "bg-transparent"}`} aria-hidden />
            )}
            <span className="truncate">{branch.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">{branch.commit}</span>
          </button>
        ))}
      </div>
      {error && <p className="px-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}

function CommitSection({ commits, onSelect }: { commits: UIGitCommit[]; onSelect: (commit: UIGitCommit, trigger?: HTMLElement | null) => void }) {
  const t = useT();
  return (
    <section className="space-y-1">
      <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-faint">{t("gitRecentCommits")}</h3>
      <div className="space-y-0.5">
        {commits.map((commit) => (
          <button key={commit.hash} type="button" onClick={(event) => onSelect(commit, event.currentTarget)} className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover" title={`${commit.hash} ${commit.subject}`}>
            <span className="flex min-w-0 items-center gap-2 text-[11px]">
              <span className="shrink-0 font-mono text-accent">{commit.shortHash}</span>
              <span className="truncate text-muted">{commit.subject}</span>
            </span>
            <span className="pl-12 text-[10px] text-faint">{commit.author} · {formatGitTimestamp(commit.date)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function CommitDiffFiles({ data }: { data: UIGitCommitDetail }) {
  const t = useT();
  const patches = useMemo(() => splitCommitDiffByFile(data.diff), [data.diff]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return (
    <div className="space-y-1">
      {data.files.map((file, index) => {
        const isOpen = expanded.has(index);
        const patch = patches[index] ?? "";
        const label = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
        return (
          <div key={`${label}-${index}`} className="overflow-hidden rounded-md border border-line">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })}
              className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-xs text-muted hover:bg-hover hover:text-ink"
            >
              <span className="w-3 shrink-0 text-center text-faint" aria-hidden>{isOpen ? "⌄" : "›"}</span>
              <span className="shrink-0 font-mono text-accent">{file.status}</span>
              <span className="min-w-0 flex-1 break-all">{label}</span>
            </button>
            {isOpen && (patch ? <DiffView text={patch} maxHeight="max-h-80" /> : <p className="border-t border-line px-3 py-2 text-xs text-faint">{t("gitNoDiff")}</p>)}
          </div>
        );
      })}
    </div>
  );
}

export function GitCommitContent({ data }: { data: UIGitCommitDetail }) {
  const t = useT();
  return (
    <div className="space-y-3 text-xs text-muted">
      <div>
        <p>{data.author} · {formatGitTimestamp(data.date)}</p>
        <p className="mt-1 break-all font-mono text-[10px] text-faint">{data.hash}</p>
      </div>
      {data.body && <pre className="whitespace-pre-wrap font-sans">{data.body}</pre>}
      <h4 className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{t("gitChangedFiles")}</h4>
      <CommitDiffFiles data={data} />
    </div>
  );
}

function CommitDetail({ cwd, hash, onClose }: { cwd: string; hash: string; onClose: () => void }) {
  const t = useT();
  const { data, isPending, isError } = useGitCommit(cwd, hash);
  if (isPending) return <div className="flex justify-center p-4"><LoadingIndicator label={t("loading")} showLabel /></div>;
  if (isError || !data) return <div className="p-4 text-sm text-red-500">{t("gitOperationFailed")}</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button type="button" onClick={onClose} aria-label={t("gitBackToLog")} title={t("gitBackToLog")} className="flex size-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink">←</button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-ink">{data.subject}</h3>
          <p className="truncate font-mono text-[10px] text-faint">{formatGitTimestamp(data.date)}</p>
        </div>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto p-3">
        <GitCommitContent data={data} />
      </div>
    </div>
  );
}

export function GitWorkspacePanel({ cwd, onPreviewFile, docked = true, onClose, onSelectCommit }: { cwd?: string; onPreviewFile?: (file: PreviewFileSelection) => void; docked?: boolean; onClose?: () => void; onSelectCommit?: (commit: UIGitCommit, trigger?: HTMLElement | null) => void }) {
  const t = useT();
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const { data: status, isPending: statusPending, isError: statusError } = useGitStatus(cwd);
  const { data: branches = [], isFetching: branchesFetching } = useGitBranches(cwd, !!status);
  const { data: commits = [], isFetching: commitsFetching } = useGitLog(cwd, !!status);
  const files = useMemo(() => {
    if (!status) return [];
    return [...status.staged, ...status.unstaged, ...status.untracked.filter((file) => !status.staged.some((item) => item.path === file.path))];
  }, [status]);

  if (selectedCommit && cwd && !onSelectCommit) return <CommitDetail cwd={cwd} hash={selectedCommit} onClose={() => setSelectedCommit(null)} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex items-center gap-1 border-b border-line px-3 ${docked ? "py-2.5" : "py-2"}`}>
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-ink" title={cwd}>{status?.branch ? <span className="font-mono text-sm">{status.branch}</span> : t("git")}</h2>
        {onClose && <button type="button" onClick={onClose} aria-label={t("closeFiles")} title={t("closeFiles")} className="flex size-8 items-center justify-center rounded-lg text-faint hover:bg-hover hover:text-ink">×</button>}
      </div>
      {statusPending && <div className="flex justify-center p-4"><LoadingIndicator label={t("loading")} showLabel /></div>}
      {statusError && <div className="p-4 text-sm text-muted">{t("gitNotRepository")}</div>}
      {status && !statusError && (
        <>
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2 text-[11px] text-muted">
            <span className={status.isDirty ? "text-amber-500" : "text-emerald-500"}>{status.isDirty ? t("gitDirty") : t("gitClean")}</span>
            {status.staged.length > 0 && <span>{status.staged.length} {t("gitStaged")}</span>}
            {status.unstaged.length > 0 && <span>{status.unstaged.length} {t("gitChanged")}</span>}
            {status.untracked.length > 0 && <span>{status.untracked.length} {t("gitUntracked")}</span>}
            {(status.ahead > 0 || status.behind > 0) && <span>↑{status.ahead} ↓{status.behind}</span>}
          </div>
          <div className="thin-scroll flex-1 space-y-5 overflow-y-auto p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            {status.conflicted.length > 0 && <FileGroup cwd={cwd!} title={t("gitConflicted")} files={status.conflicted} onPreviewFile={onPreviewFile} />}
            <FileGroup cwd={cwd!} title={t("gitStagedFiles")} files={status.staged} onPreviewFile={onPreviewFile} />
            <FileGroup cwd={cwd!} title={t("gitChangedFiles")} files={status.unstaged} onPreviewFile={onPreviewFile} />
            <FileGroup cwd={cwd!} title={t("gitUntrackedFiles")} files={status.untracked} onPreviewFile={onPreviewFile} />
            <BranchSection cwd={cwd!} status={status} branches={branches} />
            {branchesFetching && <LoadingIndicator label={t("loading")} size="sm" className="px-2" />}
            <CommitSection commits={commits} onSelect={(commit, trigger) => onSelectCommit ? onSelectCommit(commit, trigger) : setSelectedCommit(commit.hash)} />
            {commitsFetching && <LoadingIndicator label={t("loading")} size="sm" className="px-2" />}
            {files.length === 0 && <p className="px-2 text-sm text-faint">{t("gitNoChanges")}</p>}
          </div>
        </>
      )}
    </div>
  );
}
