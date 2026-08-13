import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
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
  const readyNotifiedRef = useRef(false);
  const errorNotifiedRef = useRef<unknown>(null);
  const options = useMemo(
    () => createFileViewerOptions({ mobile, theme, locale }),
    [mobile, theme, locale],
  );
  const handleStateChange = useCallback(
    (state: { ready: boolean; error: unknown | null }) => {
      if (state.error) {
        readyNotifiedRef.current = false;
        if (errorNotifiedRef.current !== state.error) {
          errorNotifiedRef.current = state.error;
          onError?.(state.error);
        }
        return;
      }

      errorNotifiedRef.current = null;
      if (state.ready) {
        if (!readyNotifiedRef.current) {
          readyNotifiedRef.current = true;
          onReady?.();
        }
      } else {
        readyNotifiedRef.current = false;
      }
    },
    [onError, onReady],
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
