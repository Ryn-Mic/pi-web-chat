import { useEffect, useRef, useState } from "react";
import { authHeaders, setAuthStatus } from "../lib/auth";
import {
  createPreviewFrameSrc,
  isPreviewFrameMessage,
  type PreviewFrameErrorCode,
} from "../lib/file-preview-frame";
import { useT, type Locale } from "../lib/i18n";
import { requestOpenFilesDrawer } from "../lib/drawer";
import type { Theme } from "../lib/theme";
import type { PreviewFileSelection } from "./FileTreePanel";

export interface MobilePreviewSelection extends PreviewFileSelection {
  trigger?: HTMLElement | null;
}

export function MobileFilePreview({
  selection,
  theme,
  locale,
  onClose,
}: {
  selection: MobilePreviewSelection;
  theme: Theme;
  locale: Locale;
  onClose(): void;
}) {
  const t = useT();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const historyLayerRef = useRef(false);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<PreviewFrameErrorCode | null>(null);

  useEffect(() => {
    history.pushState({ ...(history.state ?? {}), filePreview: true }, "");
    historyLayerRef.current = true;
    const handlePopState = () => {
      historyLayerRef.current = false;
      onClose();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
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
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { id?: string };
        if (!body.id) throw new Error("missing capability");
        setSrc(createPreviewFrameSrc(body.id));
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError("failed");
      });
    return () => controller.abort();
  }, [selection.cwd, selection.path, theme, locale]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!isPreviewFrameMessage(event, iframeRef.current?.contentWindow ?? null, location.origin)) return;
      if (event.data.type === "file-preview-error") setError(event.data.code);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const close = () => {
    if (historyLayerRef.current && history.state?.filePreview) history.back();
    else onClose();
    requestAnimationFrame(() => selection.trigger?.focus());
  };
  const backToFiles = () => {
    close();
    window.setTimeout(requestOpenFilesDrawer, 0);
  };

  return (
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-canvas">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-[max(0.25rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pr-[max(0.25rem,env(safe-area-inset-right))]">
        <button
          type="button"
          onClick={backToFiles}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-hover"
          aria-label={t("backToFiles")}
          title={t("backToFiles")}
        >
          <span aria-hidden>‹</span>
        </button>
        <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-ink" title={selection.path}>
          {selection.name}
        </div>
        <button
          type="button"
          onClick={close}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-hover"
          aria-label={t("closePreview")}
          title={t("closePreview")}
        >
          <span aria-hidden>×</span>
        </button>
      </header>
      <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        {error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
            Preview unavailable: {error}
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
          <div className="h-full animate-pulse bg-hover" aria-busy="true" />
        )}
      </div>
    </div>
  );
}
