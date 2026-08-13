import { useCallback, useEffect, useState } from "react";
import { precheckFileViewerSource } from "@file-viewer/core/headless";
import {
  loadDesktopPreviewFile,
  FilePreviewError,
  isAbortError,
  type PreviewErrorCode,
} from "../lib/file-preview-api";
import type { Messages } from "../i18n/en";
import { useLocale, useT } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { FileViewerSurface } from "./FileViewerSurface";

interface FilePreviewPaneProps {
  cwd: string;
  path: string;
  name: string;
  refreshToken?: number;
}

type PaneStatus =
  | { kind: "loading" }
  | { kind: "ready"; file: File }
  | { kind: "error"; code: PreviewErrorCode };

function errorKey(code: PreviewErrorCode): keyof Messages {
  switch (code) {
    case "unsupported":
      return "filePreviewUnsupported";
    case "malformed":
      return "filePreviewMalformed";
    case "too-large":
      return "filePreviewTooLarge";
    case "forbidden":
      return "filePreviewForbidden";
    case "missing":
      return "filePreviewMissing";
    case "changed":
      return "filePreviewChanged";
    case "expired":
      return "filePreviewExpired";
    case "failed":
    default:
      return "filePreviewFailed";
  }
}

export function FilePreviewPane({
  cwd,
  path,
  name,
  refreshToken = 0,
}: FilePreviewPaneProps) {
  const t = useT();
  const theme = useTheme();
  const locale = useLocale();
  const [status, setStatus] = useState<PaneStatus>({ kind: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus({ kind: "loading" });

    loadDesktopPreviewFile({ cwd, path, signal: controller.signal })
      .then(async (file) => {
        const check = await precheckFileViewerSource(file);
        if (cancelled) return;

        if (!check.previewable) {
          setStatus({ kind: "error", code: "unsupported" });
          return;
        }
        if (check.valid === false) {
          setStatus({ kind: "error", code: "malformed" });
          return;
        }

        setStatus({ kind: "ready", file });
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

  if (status.kind === "loading") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-2/5 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        </div>
        <div className="flex-1 animate-pulse rounded bg-black/5 dark:bg-white/5" />
        <div className="text-sm text-neutral-500">
          {t("filePreviewLoading", { name })}
        </div>
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-sm text-neutral-600 dark:text-neutral-300">
          {t(errorKey(status.code), { name })}
        </div>
        <button
          type="button"
          onClick={handleRetry}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
        >
          {t("filePreviewRetry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="border-b border-black/5 px-4 py-2 text-sm font-medium dark:border-white/10">
        {name}
      </div>
      <div className="min-h-0 flex-1">
        <FileViewerSurface
          file={status.file}
          mobile={false}
          theme={theme}
          locale={locale}
          onError={() => setStatus({ kind: "error", code: "failed" })}
        />
      </div>
    </div>
  );
}
