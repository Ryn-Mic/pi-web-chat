import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileViewerNotificationGate } from "../lib/file-viewer-notifications";
import { createFileViewerOptions } from "../lib/file-viewer-options";
import { useT, type Locale } from "../lib/i18n";
import type { Theme } from "../lib/theme";
import { LoadingIndicator } from "./LoadingIndicator";

const LazyFileViewer = lazy(async () => {
  const mod = await import("@file-viewer/react-full");
  mod.setDefaultFullAssetBaseUrl("/file-viewer/");
  return { default: mod.FileViewer };
});

export function FileViewerSurface({
  file,
  mobile,
  theme,
  locale,
  onReady,
  onError,
}: {
  file: File;
  mobile: boolean;
  theme: Theme;
  locale: Locale;
  onReady?: () => void;
  onError?: (error: unknown) => void;
}) {
  const t = useT();
  const [viewerReady, setViewerReady] = useState(false);
  const gateRef = useRef(createFileViewerNotificationGate());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setViewerReady(false);
  }, [file]);
  const options = useMemo(
    () => createFileViewerOptions({ mobile, theme, locale }),
    [mobile, theme, locale],
  );
  const handleStateChange = useCallback(
    (state: { loading?: boolean; ready: boolean; error: unknown | null }) => {
      if (!mountedRef.current) return;
      setViewerReady(state.ready && !state.error);
      const event = gateRef.current(file, state);
      if (event?.type === "ready") {
        setViewerReady(true);
        onReady?.();
      } else if (event?.type === "error") {
        setViewerReady(false);
        onError?.(event.error);
      }
    },
    [file, onError, onReady],
  );

  return (
    <div className="relative h-full min-h-0 w-full">
      {!viewerReady && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas">
          <LoadingIndicator label={t("loading")} showLabel />
        </div>
      )}
      <Suspense fallback={null}>
        <LazyFileViewer
          file={file}
          options={options}
          className="h-full min-h-0 w-full"
          onStateChange={handleStateChange}
        />
      </Suspense>
    </div>
  );
}
