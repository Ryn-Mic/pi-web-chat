import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, setAuthStatus } from "../lib/auth";
import {
  createPreviewFrameSrc,
  isPreviewFrameMessage,
  type PreviewFrameErrorCode,
} from "../lib/file-preview-frame";
import { useT, type Locale } from "../lib/i18n";
import { requestOpenFilesDrawer } from "../lib/drawer";
import { useMobileHistoryLayer } from "../lib/mobile-history-layer";
import type { Theme } from "../lib/theme";
import type { PreviewFileSelection } from "./FileTreePanel";
import { LoadingIndicator } from "./LoadingIndicator";
import { DismissActionIcon, NavigationActionIcon } from "./MorphIcons";
import { filePreviewErrorKey } from "../lib/file-preview-error";
import { confirmDiscardTextFileDraft, getTextFileDraft } from "../lib/file-text-drafts";
import { FileTextEditor } from "./FileTextEditor";

export interface MobilePreviewSelection extends PreviewFileSelection {
  trigger?: HTMLElement | null;
}

export function MobileFilePreview({
  selection,
  workspaceKey,
  theme,
  locale,
  onClose,
}: {
  selection: MobilePreviewSelection;
  workspaceKey: string;
  theme: Theme;
  locale: Locale;
  onClose(): void;
}) {
  const t = useT();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canClose = useCallback(() => confirmDiscardTextFileDraft(selection.cwd, selection.path, t("fileEditDiscard"), workspaceKey), [selection.cwd, selection.path, t, workspaceKey]);
  const closeHistoryLayer = useMobileHistoryLayer(onClose, canClose);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<PreviewFrameErrorCode | null>(null);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(() => !!getTextFileDraft(selection.cwd, selection.path, workspaceKey));

  useEffect(() => {
    const controller = new AbortController();
    setSrc(null);
    setError(null);
    void fetch("/api/files/preview-context", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        cwd: selection.cwd,
        path: selection.path,
        theme,
        locale,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) setAuthStatus("unauthenticated");
        if (!response.ok) {
          setError(response.status === 415 ? "unsupported" : response.status === 413 ? "too-large" : response.status === 404 ? "missing" : response.status === 403 ? "forbidden" : "failed");
          return;
        }
        const body = (await response.json()) as { id?: string };
        if (!body.id) throw new Error("missing capability");
        setSrc(createPreviewFrameSrc(body.id));
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError("failed");
      });
    return () => controller.abort();
  }, [selection.cwd, selection.path, theme, locale, retry]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!isPreviewFrameMessage(event, iframeRef.current?.contentWindow ?? null, location.origin)) return;
      if (event.data.type === "file-preview-error") setError(event.data.code);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const close = () => {
    if (!closeHistoryLayer()) return false;
    requestAnimationFrame(() => selection.trigger?.focus());
    return true;
  };
  const backToFiles = () => {
    if (close()) window.setTimeout(requestOpenFilesDrawer, 0);
  };

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-[var(--app-viewport-height,100dvh)] flex-col bg-canvas">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-[max(0.25rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pr-[max(0.25rem,env(safe-area-inset-right))]">
        <button
          type="button"
          onClick={backToFiles}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-hover"
          aria-label={t("backToFiles")}
          title={t("backToFiles")}
        >
          <NavigationActionIcon direction="back" size={20} />
        </button>
        <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-ink" title={selection.path}>
          {selection.name}
        </div>
        {!editing && <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded px-2 py-2 text-xs text-muted hover:bg-hover">{t("fileEditOpen")}</button>}
        <button
          type="button"
          onClick={close}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-hover"
          aria-label={t("closePreview")}
          title={t("closePreview")}
        >
          <DismissActionIcon size={20} />
        </button>
      </header>
      <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        {editing ? <FileTextEditor key={JSON.stringify([workspaceKey, selection.cwd, selection.path])} cwd={selection.cwd} path={selection.path} name={selection.name} workspaceKey={workspaceKey} mobile onClose={() => { setEditing(false); setRetry((value) => value + 1); }} /> : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
            {t(filePreviewErrorKey(error), { name: selection.name })}
            <button type="button" onClick={() => setRetry((value) => value + 1)} className="rounded px-3 py-2 text-ink hover:bg-hover">{t("filePreviewRetry")}</button>
          </div>
        ) : src ? (
          <iframe
            ref={iframeRef}
            src={src}
            sandbox="allow-scripts allow-same-origin"
            title={t("previewFile", { name: selection.name })}
            className="h-full w-full border-0 bg-canvas"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-hover/40">
            <LoadingIndicator label={t("filePreviewLoading", { name: selection.name })} showLabel />
          </div>
        )}
      </div>
    </div>
  );
}
