const CHUNK_RECOVERY_KEY = "pi-web-chat:chunk-recovery";

type ChunkRecoveryOptions = {
  version: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  caches?: Pick<CacheStorage, "keys" | "delete">;
  reload: () => void;
  now?: () => number;
};

const RELOAD_LOOP_GUARD_MS = 60_000;

/**
 * Recover once when a deployment removes a chunk referenced by an older tab.
 * The version marker prevents a broken deployment from causing a reload loop.
 */
export async function recoverStaleChunk({
  version,
  storage,
  caches,
  reload,
  now = Date.now,
}: ChunkRecoveryOptions): Promise<boolean> {
  try {
    const currentTime = now();
    const previous = storage.getItem(CHUNK_RECOVERY_KEY);
    if (previous) {
      try {
        const marker = JSON.parse(previous) as { version?: unknown; timestamp?: unknown };
        const elapsed =
          typeof marker.timestamp === "number" ? currentTime - marker.timestamp : Number.NaN;
        if (
          marker.version === version &&
          Number.isFinite(elapsed) &&
          elapsed >= 0 &&
          elapsed < RELOAD_LOOP_GUARD_MS
        ) {
          return false;
        }
      } catch {
        // Replace an older or corrupted marker below.
      }
    }
    storage.setItem(CHUNK_RECOVERY_KEY, JSON.stringify({ version, timestamp: currentTime }));
  } catch {
    // Without a durable marker, reloading could loop forever.
    return false;
  }

  try {
    if (caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // A network reload is still useful when cache cleanup is unavailable.
  }
  reload();
  return true;
}

/** Install before React so route-level lazy imports cannot reach the error page. */
export function installChunkLoadRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    void recoverStaleChunk({
      version: __APP_VERSION__,
      storage: window.sessionStorage,
      caches: "caches" in window ? window.caches : undefined,
      reload: () => window.location.reload(),
    });
  });
}
