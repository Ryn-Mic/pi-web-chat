import { useGitCommit } from "../lib/api";
import { requestOpenFilesDrawer } from "../lib/drawer";
import { useT } from "../lib/i18n";
import { useMobileHistoryLayer } from "../lib/mobile-history-layer";
import { GitCommitContent } from "./GitWorkspacePanel";
import { LoadingIndicator } from "./LoadingIndicator";
import { DismissActionIcon, NavigationActionIcon } from "./MorphIcons";

export interface MobileGitCommitSelection {
  cwd: string;
  hash: string;
  subject: string;
  trigger?: HTMLElement | null;
}

export function MobileGitCommitDetail({
  selection,
  onClose,
}: {
  selection: MobileGitCommitSelection;
  onClose(): void;
}) {
  const t = useT();
  const closeHistoryLayer = useMobileHistoryLayer(onClose);
  const { data, isPending, isError } = useGitCommit(selection.cwd, selection.hash);

  const close = () => {
    closeHistoryLayer();
    requestAnimationFrame(() => selection.trigger?.focus());
  };
  const backToGit = () => {
    close();
    window.setTimeout(() => requestOpenFilesDrawer("git"), 0);
  };

  return (
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-canvas">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-[max(0.25rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pr-[max(0.25rem,env(safe-area-inset-right))]">
        <button
          type="button"
          onClick={backToGit}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-hover"
          aria-label={t("backToGit")}
          title={t("backToGit")}
        >
          <NavigationActionIcon direction="back" size={20} />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h2 className="truncate font-mono text-sm font-semibold text-accent" title={selection.hash}>{selection.hash.slice(0, 7)}</h2>
        </div>
        <button
          type="button"
          onClick={close}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-hover"
          aria-label={t("closeCommit")}
          title={t("closeCommit")}
        >
          <DismissActionIcon size={20} />
        </button>
      </header>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {isPending && <div className="flex justify-center"><LoadingIndicator label={t("loading")} showLabel /></div>}
        {isError && <div className="text-sm text-red-500">{t("gitOperationFailed")}</div>}
        {data && <GitCommitContent data={data} />}
      </div>
    </div>
  );
}
