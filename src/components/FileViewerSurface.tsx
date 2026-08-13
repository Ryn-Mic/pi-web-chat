import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { createFileViewerNotificationGate } from "../lib/file-viewer-notifications";
import { createFileViewerOptions } from "../lib/file-viewer-options";
import type { Locale } from "../lib/i18n";
import type { Theme } from "../lib/theme";

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
  const gateRef = useRef(createFileViewerNotificationGate());
  const options = useMemo(
    () => createFileViewerOptions({ mobile, theme, locale }),
    [mobile, theme, locale],
  );
  const handleStateChange = useCallback(
    (state: { ready: boolean; error: unknown | null }) => {
      const event = gateRef.current(file, state);
      if (event?.type === "ready") {
        onReady?.();
      } else if (event?.type === "error") {
        onError?.(event.error);
      }
    },
    [file, onError, onReady],
  );

  return (
    <Suspense fallback={<div className="h-full min-h-0 w-full" aria-busy="true" />}>
      <LazyFileViewer
        file={file}
        options={options}
        className="h-full min-h-0 w-full"
        onStateChange={handleStateChange}
      />
    </Suspense>
  );
}
