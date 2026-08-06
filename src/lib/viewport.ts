/**
 * iOS PWA viewport handling.
 *
 * Problems this addresses:
 * - 100dvh in standalone leaves dead space at the bottom.
 * - env(safe-area-inset-*) can over-report, inflating padding.
 * - When the keyboard opens, iOS scrolls the whole page up (composer flies
 *   to the top, header disappears) unless the body scroll is locked.
 *
 * Strategy: lock body scrolling and size #root to visualViewport.height so
 * the composer always sits just above the keyboard, with capped safe areas.
 * #root itself is NOT position:fixed (that can truncate on iOS 26+).
 *
 * Performance notes (measured with Playwright; the original code janked on
 * iOS because every visualViewport scroll/resize fired DOM writes → reflows):
 * - safe areas barely change during a session: measure once, re-measure only
 *   on orientationchange
 * - only write --app-height when the value actually changes
 * - visualViewport "scroll" fires every frame while scrolling and only
 *   changes offsetTop, which nothing uses — don't listen to it at all
 * - rAF-coalesce event handlers so a storm costs one layout pass per frame
 */
const SAFE_TOP_MAX = 60;
const SAFE_BOTTOM_MAX = 34;

function measureEnvPadding(side: "top" | "bottom"): number {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "left:0",
    "visibility:hidden",
    "pointer-events:none",
    side === "top"
      ? "padding-top:env(safe-area-inset-top, 0px)"
      : "padding-bottom:env(safe-area-inset-bottom, 0px)",
  ].join(";");
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const raw = side === "top" ? cs.paddingTop : cs.paddingBottom;
  el.remove();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export function initViewportLock() {
  const root = document.documentElement;

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (typeof navigator !== "undefined" &&
      "standalone" in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone));

  root.classList.toggle("ua-standalone", standalone);

  // Safe areas are cached: they only change on rotation / entering-exiting
  // fullscreen, so re-measuring (DOM append + forced reflow) on every resize
  // is pure waste.
  let safeTop: number | null = null;
  let safeBottom: number | null = null;
  const applySafeAreas = (force = false) => {
    if (safeTop === null || force) {
      const top = Math.min(Math.max(measureEnvPadding("top"), 0), SAFE_TOP_MAX);
      if (top !== safeTop) root.style.setProperty("--safe-top", `${top}px`);
      safeTop = top;
    }
    if (safeBottom === null || force) {
      const bottom = Math.min(Math.max(measureEnvPadding("bottom"), 0), SAFE_BOTTOM_MAX);
      if (bottom !== safeBottom) root.style.setProperty("--safe-bottom", `${bottom}px`);
      safeBottom = bottom;
    }
  };

  let lastAppHeight = "";
  const applyHeight = () => {
    const vv = window.visualViewport;
    const inner = window.innerHeight;
    const vvHeight = Math.round(vv?.height ?? inner);
    const offsetTop = Math.round(vv?.offsetTop ?? 0);

    // Keyboard (or other overlay) shrank the visible viewport.
    const keyboardOpen = vvHeight < inner - 80 || offsetTop > 0;

    // When the keyboard is closed, size to innerHeight: in iOS standalone
    // visualViewport.height can under-report the bottom safe area (measured
    // with Playwright: vv=630 vs inner=664 → composer floats 34px off the
    // bottom). Only the keyboard case should use the (smaller) visualViewport.
    const height = keyboardOpen ? vvHeight : Math.round(inner);

    // Write --app-height only when it changed — it lives on #root's height,
    // so every write forces a full-page reflow.
    if (height !== Number(lastAppHeight)) {
      root.style.setProperty("--app-height", `${height}px`);
      lastAppHeight = String(height);
    }
    root.classList.toggle("ua-keyboard", keyboardOpen);
    // Note: no window.scrollTo() here. With body position:fixed the document
    // can't scroll, and calling scrollTo on iOS (especially while the keyboard
    // animation is fighting for the viewport) is what makes the whole page
    // drift upward. The fixed body + overflow:hidden already keeps the layout
    // in place.
  };

  const applyAll = (forceSafeAreas = false) => {
    if (!document.body) return;
    applySafeAreas(forceSafeAreas);
    applyHeight();
  };

  // Coalesce bursts (keyboard animation, orientation, focus) to one pass per frame.
  let pending = false;
  const schedule = (fn: () => void) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn();
    });
  };
  const scheduleAll = () => schedule(() => applyAll());
  const scheduleHeight = () => schedule(applyHeight);

  if (document.body) applyAll();
  else document.addEventListener("DOMContentLoaded", () => applyAll(), { once: true });

  // iOS standalone can report a wrong viewport height right at load (before
  // the layout viewport settles), with no resize event following. Re-measure
  // once after load — with the change-detection guards this costs nothing when
  // the value is already right.
  window.addEventListener(
    "load",
    () => {
      requestAnimationFrame(() => requestAnimationFrame(() => applyAll()));
      setTimeout(applyAll, 300);
    },
    { once: true },
  );

  // Only resize matters for height. visualViewport "scroll" fires every frame
  // while scrolling and only changes offsetTop (which nothing reads) — not
  // listening to it keeps scrolling jank-free.
  window.visualViewport?.addEventListener("resize", scheduleHeight);
  window.addEventListener("resize", scheduleAll);
  window.addEventListener("orientationchange", () => {
    // Safe areas and viewport can both change on rotation.
    safeTop = null;
    safeBottom = null;
    requestAnimationFrame(() => requestAnimationFrame(() => applyAll(true)));
  });
  // iOS sometimes fires focus before the viewport resizes.
  window.addEventListener("focusin", () => {
    scheduleHeight();
    setTimeout(applyHeight, 300);
  });
  window.addEventListener("focusout", () => {
    setTimeout(scheduleAll, 100);
  });
}
