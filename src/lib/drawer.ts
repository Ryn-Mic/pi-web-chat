/**
 * Session drawer open-request event bus.
 *
 * SessionsDrawer manages the base-ui Dialog open state internally, so external
 * triggers (like the edge-swipe gesture) request opening via this event.
 */
const listeners = new Set<() => void>();

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
