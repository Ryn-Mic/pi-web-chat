import { useCallback, useEffect, useState } from "react";
import { precheckFileViewerSource } from "@file-viewer/core/headless";
import {
  loadDesktopPreviewFile,
  FilePreviewError,
  isAbortError,
  type PreviewErrorCode,
} from "../lib/file-preview-api";
import { filePreviewErrorKey } from "../lib/file-preview-error";
import { fallbackTextPreview } from "../lib/file-preview-text";
import { getTextFileDraft } from "../lib/file-text-drafts";
import { useLocale, useT } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { FileViewerSurface } from "./FileViewerSurface";
import { LoadingIndicator } from "./LoadingIndicator";
import { FileTextEditor } from "./FileTextEditor";

interface FilePreviewPaneProps {
  cwd: string;
  path: string;
  name: string;
  workspaceKey: string;
  refreshToken?: number;
}

type PaneStatus =
  | { kind: "loading" }
  | { kind: "ready"; file: File; editable: boolean }
  | { kind: "error"; code: PreviewErrorCode; editable?: boolean };

export function FilePreviewPane({
  cwd,
  path,
  name,
  workspaceKey,
  refreshToken = 0,
}: FilePreviewPaneProps) {
  const t = useT();
  const theme = useTheme();
  const locale = useLocale();
  const [status, setStatus] = useState<PaneStatus>({ kind: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);
  const [editing, setEditing] = useState(() => !!getTextFileDraft(cwd, path, workspaceKey));

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus({ kind: "loading" });

    loadDesktopPreviewFile({ cwd, path, signal: controller.signal })
      .then(async (file) => {
        const check = await precheckFileViewerSource(file);
        const textFallback = await fallbackTextPreview(file);
        if (cancelled) return;

        if (!check.previewable) {
          setStatus(textFallback ? { kind: "ready", file: textFallback, editable: true } : { kind: "error", code: "unsupported" });
          return;
        }
        if (check.valid === false) {
          setStatus(textFallback ? { kind: "ready", file: textFallback, editable: true } : { kind: "error", code: "malformed" });
          return;
        }

        setStatus({ kind: "ready", file, editable: textFallback !== null });
      })
      .catch((err) => {
        if (cancelled) return;
        if (isAbortError(err)) {
          return;
        }
        if (err instanceof FilePreviewError) {
          setStatus({ kind: "error", code: err.code });
          return;
        }
        setStatus({ kind: "error", code: "failed" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cwd, path, refreshToken, retryNonce]);

  const handleRetry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  if (editing) return <FileTextEditor key={JSON.stringify([workspaceKey, cwd, path])} cwd={cwd} path={path} name={name} workspaceKey={workspaceKey} onClose={() => { setEditing(false); handleRetry(); }} />;

  if (status.kind === "loading") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-2/5 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        </div>
        <div className="flex-1 animate-pulse rounded bg-black/5 dark:bg-white/5" />
        <LoadingIndicator label={t("filePreviewLoading", { name })} showLabel className="text-sm" />
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-sm text-neutral-600 dark:text-neutral-300">
          {t(filePreviewErrorKey(status.code), { name })}
        </div>
        <button
          type="button"
          onClick={handleRetry}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
        >
          {t("filePreviewRetry")}
        </button>
        {(status.editable || status.code === "unsupported") && (
          <button type="button" onClick={() => setEditing(true)} className="rounded px-4 py-2 text-sm text-ink hover:bg-hover">{t("fileEditOpen")}</button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2 text-sm font-medium">
        <span className="min-w-0 truncate">{name}</span>
        {status.editable && <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded px-2 py-1 text-xs text-muted hover:bg-hover">{t("fileEditOpen")}</button>}
      </div>
      <div className="min-h-0 flex-1">
        <FileViewerSurface
          file={status.file}
          mobile={false}
          theme={theme}
          locale={locale}
          onError={() => setStatus({ kind: "error", code: "failed", editable: status.editable })}
        />
      </div>
    </div>
  );
}
