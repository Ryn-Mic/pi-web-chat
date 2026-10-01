import { useSyncExternalStore } from "react";

/**
 * Drawer open-request event buses (sessions + files).
 *
 * Each drawer manages the base-ui Dialog open state internally, so external
 * triggers (like the edge-swipe gesture) request opening via this event.
 */
const listeners = new Set<() => void>();
const filesListeners = new Set<(view?: "files" | "git") => void>();

let sessionsDrawerOpen = false;
let filesDrawerOpen = false;
let modalOverlayOpen = false;
const stateListeners = new Set<() => void>();

function notifyState() {
  for (const l of stateListeners) l();
}

export function setSessionsDrawerOpen(open: boolean) {
  if (sessionsDrawerOpen === open) return;
  sessionsDrawerOpen = open;
  notifyState();
}

export function setFilesDrawerOpen(open: boolean) {
  if (filesDrawerOpen === open) return;
  filesDrawerOpen = open;
  notifyState();
}

export function setModalOverlayOpen(open: boolean) {
  if (modalOverlayOpen === open) return;
  modalOverlayOpen = open;
  notifyState();
}

export function useAnyDrawerOpen(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      stateListeners.add(onStoreChange);
      return () => {
        stateListeners.delete(onStoreChange);
      };
    },
    () => sessionsDrawerOpen || filesDrawerOpen || modalOverlayOpen,
    () => false,
  );
}

/** Request the drawer to open (the subscribing SessionsDrawer opens) */
export function requestOpenSessionsDrawer() {
  for (const l of listeners) l();
}

/** Subscribe to drawer-open requests. Returns a cleanup function. */
export function onRequestOpenSessionsDrawer(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Request the files drawer to open (header button on mobile, right-edge swipe) */
export function requestOpenFilesDrawer(view?: "files" | "git") {
  for (const l of filesListeners) l(view);
}

/** Subscribe to files-drawer open requests. Returns a cleanup function. */
export function onRequestOpenFilesDrawer(listener: (view?: "files" | "git") => void) {
  filesListeners.add(listener);
  return () => {
    filesListeners.delete(listener);
  };
}
