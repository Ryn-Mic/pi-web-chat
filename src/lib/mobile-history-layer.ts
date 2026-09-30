import { useCallback, useEffect, useRef } from "react";

interface HistoryLayerHost {
  history: Pick<History, "state" | "pushState" | "replaceState" | "back">;
  href(): string;
  onPop(listener: () => void): () => void;
}

/** Own one overlay entry; deferred cleanup also tolerates StrictMode effect replay. */
export function createMobileHistoryLayer(onClose: () => void, host: HistoryLayerHost) {
  const id = crypto.randomUUID();
  const mountedHref = host.href();
  let closing = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  const ownsEntry = () => host.history.state?.mobilePreviewLayer === id;

  return {
    mount() {
      if (cleanupTimer !== null) clearTimeout(cleanupTimer);
      cleanupTimer = null;
      if (!ownsEntry()) {
        host.history.pushState({ ...(host.history.state ?? {}), mobilePreviewLayer: id }, "");
      }
      const removeListener = host.onPop(() => {
        if (ownsEntry()) return;
        closing = true;
        onClose();
      });
      return () => {
        removeListener();
        cleanupTimer = setTimeout(() => {
          cleanupTimer = null;
          if (closing || !ownsEntry()) return;
          closing = true;
          if (host.href() === mountedHref) host.history.back();
          else {
            // A route already replaced this entry. Keep its new URL and router
            // state rather than navigating back to the overlay's old session.
            const { mobilePreviewLayer: _layer, ...state } = host.history.state;
            host.history.replaceState(state, "");
          }
        }, 0);
      };
    },
    close() {
      if (closing) return;
      closing = true;
      if (ownsEntry()) host.history.back();
      else onClose();
    },
  };
}

/** One browser Back entry per overlay mount, with the latest parent's callback. */
export function useMobileHistoryLayer(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const layer = useRef<ReturnType<typeof createMobileHistoryLayer> | null>(null);
  if (layer.current === null) {
    layer.current = createMobileHistoryLayer(() => onCloseRef.current(), {
      history,
      href: () => location.href,
      onPop(listener) {
        window.addEventListener("popstate", listener);
        return () => window.removeEventListener("popstate", listener);
      },
    });
  }
  useEffect(() => layer.current!.mount(), []);
  return useCallback(() => layer.current!.close(), []);
}
