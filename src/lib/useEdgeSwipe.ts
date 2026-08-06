import { useEffect } from "react";

interface EdgeSwipeOptions {
  /** Whether swipe detection is enabled (default true) */
  enabled?: boolean;
  /** Touch must start within this many px of the left edge (default 28px) */
  edgeSize?: number;
  /** Rightward movement must reach this many px to trigger (default 60px) */
  threshold?: number;
  /** Called when the swipe triggers */
  onSwipeRight: () => void;
}

/**
 * Detects a swipe right from the left edge of the screen.
 * Used to open the mobile session drawer.
 */
export function useLeftEdgeSwipe({
  enabled = true,
  edgeSize = 28,
  threshold = 60,
  onSwipeRight,
}: EdgeSwipeOptions) {
  useEffect(() => {
    if (!enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let fired = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      // Only track touches that started at the left edge
      if (t.clientX <= edgeSize) {
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
        fired = false;
      } else {
        tracking = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || fired) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Trigger when horizontal movement dominates and passes the threshold
      if (dx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
        fired = true;
        tracking = false;
        onSwipeRight();
      } else if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        // Vertical scroll — stop tracking
        tracking = false;
      }
    };

    const onTouchEnd = () => {
      tracking = false;
      fired = false;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, edgeSize, threshold, onSwipeRight]);
}
