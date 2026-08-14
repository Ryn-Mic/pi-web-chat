import { precheckFileViewerSource } from "@file-viewer/core/headless";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileViewerSurface } from "./components/FileViewerSurface";
import { LoadingIndicator } from "./components/LoadingIndicator";
import { t } from "./lib/i18n";
import {
  consumePreviewContextFromHash,
  loadFramePreviewFile,
  PreviewFrameError,
  type FramePreviewFile,
  type PreviewFrameMessage,
} from "./lib/file-preview-frame";
import "./styles.css";

function notifyParent(message: PreviewFrameMessage) {
  window.parent.postMessage(message, location.origin);
}

function PreviewFrameApp() {
  const [preview, setPreview] = useState<FramePreviewFile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const contextId = consumePreviewContextFromHash();
    if (!contextId) {
      setFailed(true);
      notifyParent({ type: "file-preview-error", code: "expired" });
      return;
    }

    const controller = new AbortController();
    void loadFramePreviewFile({ contextId, signal: controller.signal })
      .then(async (next) => {
        const check = await precheckFileViewerSource(next.file);
        if (!check.previewable) throw new PreviewFrameError("unsupported");
        if (check.valid === false) throw new PreviewFrameError("malformed");
        document.documentElement.classList.toggle("dark", next.theme === "dark");
        document.documentElement.lang = next.locale;
        setPreview(next);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        const code = error instanceof PreviewFrameError ? error.code : "failed";
        setFailed(true);
        notifyParent({ type: "file-preview-error", code });
      });
    return () => controller.abort();
  }, []);

  if (failed) {
    return <div className="flex h-[100dvh] items-center justify-center bg-canvas text-sm text-muted">Preview unavailable</div>;
  }
  if (!preview) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas">
        <LoadingIndicator label={t("loading")} showLabel />
      </div>
    );
  }
  return (
    <div className="h-[100dvh] min-h-0 bg-canvas">
      <FileViewerSurface
        file={preview.file}
        mobile
        theme={preview.theme}
        locale={preview.locale === "zh-CN" ? "zh" : preview.locale === "ja-JP" ? "ja" : "en"}
        onReady={() => notifyParent({ type: "file-preview-ready" })}
        onError={() => notifyParent({ type: "file-preview-error", code: "failed" })}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PreviewFrameApp />);
