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

interface RightEdgeSwipeOptions {
  /** Whether swipe detection is enabled (default true) */
  enabled?: boolean;
  /** Touch must start within this many px of the right edge (default 28px) */
  edgeSize?: number;
  /** Leftward movement must reach this many px to trigger (default 60px) */
  threshold?: number;
  /** Called when the swipe triggers */
  onSwipeLeft: () => void;
}

interface InternalEdgeSwipeOptions {
  enabled: boolean;
  edgeSize: number;
  threshold: number;
  /** Which screen edge the touch must start at */
  direction: "left" | "right";
  /** Called when the swipe triggers */
  onSwipe: () => void;
}

/**
 * Shared edge-swipe detector. Tracks a single-finger touch that starts at the
 * chosen screen edge and fires when horizontal movement dominates and crosses
 * the threshold in the inward direction.
 */
function useEdgeSwipe({
  enabled,
  edgeSize,
  threshold,
  direction,
  onSwipe,
}: InternalEdgeSwipeOptions) {
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
      const atEdge =
        direction === "left"
          ? t.clientX <= edgeSize
          : t.clientX >= window.innerWidth - edgeSize;
      if (atEdge) {
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
      // Inward horizontal movement for the chosen edge
      const swipeDx = direction === "left" ? dx : -dx;
      // Trigger when horizontal movement dominates and passes the threshold
      if (swipeDx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
        fired = true;
        tracking = false;
        onSwipe();
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
  }, [enabled, edgeSize, threshold, direction, onSwipe]);
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
  useEdgeSwipe({
    enabled,
    edgeSize,
    threshold,
    direction: "left",
    onSwipe: onSwipeRight,
  });
}

/**
 * Detects a swipe left from the right edge of the screen.
 * Used to open the mobile files drawer.
 */
export function useRightEdgeSwipe({
  enabled = true,
  edgeSize = 28,
  threshold = 60,
  onSwipeLeft,
}: RightEdgeSwipeOptions) {
  useEdgeSwipe({
    enabled,
    edgeSize,
    threshold,
    direction: "right",
    onSwipe: onSwipeLeft,
  });
}
