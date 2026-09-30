/**
 * iOS PWA viewport handling.
 *
 * Problems this addresses:
 * - 100dvh in standalone leaves dead space at the bottom.
 * - env(safe-area-inset-*) can over-report, inflating padding.
 * - A keyboard can shrink the visual viewport without changing layout height.
 *
 * Strategy: size the app to the visible height and measure safe areas once.
 * #root itself is NOT position:fixed (that can truncate on iOS 26+).
 *
 * The viewport meta deliberately omits viewport-fit=cover: laying the app out
 * under the iOS 26 status bar puts the header inside the system's translucent
 * status material, which blurs it (see the standalone top-clearance note).
 *
 * Performance notes (measured with Playwright; the original code janked on
 * iOS because every visualViewport scroll/resize fired DOM writes → reflows):
 * - safe areas barely change during a session: measure once, re-measure only
 *   on orientationchange
 * - visible-height changes are coalesced into one animation frame
 * - panning is left to the browser: no scroll listener or offset compensation
 */
/** Guards against a wildly over-reported top inset. */
const SAFE_TOP_MAX = 140;
const SAFE_BOTTOM_MAX = 34;
const STANDALONE_SAFE_BOTTOM_FALLBACK = 34;

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

/**
 * Temporary diagnostics for tuning the iOS 26+ top clearance: the reported
 * inset alone cannot tell us whether the system bar still covers the header.
 * Rendered in the settings footer; remove once the clearance is settled.
 */
export function viewportDiagnostics(): string {
  const root = document.documentElement;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches;
  const vv = window.visualViewport;
  return [
    `top=${root.style.getPropertyValue("--safe-top").trim() || "unset"}`,
    `env=${Math.round(measureEnvPadding("top"))}`,
    `screen=${window.screen.height}`,
    `inner=${window.innerHeight}`,
    `vv=${Math.round(vv?.height ?? 0)}`,
    standalone ? "standalone" : "browser",
  ].join(" ");
}

export function initViewportLock() {
  const root = document.documentElement;

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (typeof navigator !== "undefined" &&
      "standalone" in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const iosDevice =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isIosStandalonePortrait = () =>
    standalone && iosDevice && window.matchMedia("(orientation: portrait)").matches;

  root.classList.toggle("ua-standalone", standalone);
  root.classList.toggle("ua-ios", iosDevice);

  let visibleHeight: number | null = null;
  let closedHeight = window.innerHeight;
  let viewportWidth = window.innerWidth;
  let keyboardOpen = false;
  let resizeFrame = 0;
  const applyVisibleHeight = () => {
    resizeFrame = 0;
    const viewport = window.visualViewport;
    // Pinch zoom belongs to the browser; resizing the app would rearrange the
    // content the user is trying to magnify.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = Math.round(viewport?.height ?? window.innerHeight);
    if (!Number.isFinite(height) || height <= 0) return;
    if (window.innerWidth !== viewportWidth) {
      viewportWidth = window.innerWidth;
      closedHeight = window.innerHeight;
    }
    const focused = document.activeElement;
    const editing = focused instanceof HTMLElement && (
      focused.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=range])") ||
      focused.isContentEditable
    );
    // Address-bar movement alone is smaller than a software keyboard. Retain
    // the closed height while a focused editor has a substantially shorter view.
    const nextKeyboardOpen = editing && closedHeight - height > 120;
    if (!nextKeyboardOpen) closedHeight = height;
    if (height !== visibleHeight) {
      root.style.setProperty("--app-viewport-height", `${height}px`);
      visibleHeight = height;
    }
    if (nextKeyboardOpen !== keyboardOpen) {
      root.classList.toggle("ua-keyboard-open", nextKeyboardOpen);
      keyboardOpen = nextKeyboardOpen;
    }
  };
  const scheduleVisibleHeight = () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyVisibleHeight);
  };
  applyVisibleHeight();
  window.addEventListener("resize", scheduleVisibleHeight);
  window.visualViewport?.addEventListener("resize", scheduleVisibleHeight);
  document.addEventListener("focusin", scheduleVisibleHeight);
  document.addEventListener("focusout", scheduleVisibleHeight);

  // Safe areas are cached: they only change on rotation / entering-exiting
  // fullscreen, so re-measuring (DOM append + forced reflow) on every resize
  // is pure waste.
  let safeTop: number | null = null;
  let safeBottom: number | null = null;
  const applySafeAreas = (force = false) => {
    if (safeTop === null || force) {
      // The document does not use viewport-fit=cover, so iOS reserves the
      // status bar outside the web view: env(safe-area-inset-top) is 0 and the
      // app must not add anything on top. Reserving an inset here is what put
      // the header under the system status material, which blurs whatever sits
      // beneath it.
      const top = Math.min(Math.max(measureEnvPadding("top"), 0), SAFE_TOP_MAX);
      if (top !== safeTop) root.style.setProperty("--safe-top", `${top}px`);
      safeTop = top;
    }
    if (safeBottom === null || force) {
      const measuredBottom = Math.min(Math.max(measureEnvPadding("bottom"), 0), SAFE_BOTTOM_MAX);
      const needsStandaloneFallback = isIosStandalonePortrait() && measuredBottom < 1;
      const bottom =
        needsStandaloneFallback
          ? window.screen.height >= 800
            ? STANDALONE_SAFE_BOTTOM_FALLBACK
            : 0
          : measuredBottom;
      if (bottom !== safeBottom) root.style.setProperty("--safe-bottom", `${bottom}px`);
      safeBottom = bottom;
    }
  };

  const applyAll = (forceSafeAreas = false) => {
    if (!document.body) return;
    applySafeAreas(forceSafeAreas);
  };

  if (document.body) applyAll();
  else document.addEventListener("DOMContentLoaded", () => applyAll(), { once: true });

  // iOS standalone can expose safe-area values only after the initial layout.
  // Re-measure once the page has settled.
  window.addEventListener(
    "load",
    () => {
      requestAnimationFrame(() => requestAnimationFrame(() => applyAll(true)));
      setTimeout(() => applyAll(true), 300);
    },
    { once: true },
  );

  window.addEventListener("orientationchange", () => {
    // Safe areas and viewport can both change on rotation.
    safeTop = null;
    safeBottom = null;
    closedHeight = window.innerHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      applyAll(true);
      scheduleVisibleHeight();
    }));
  });
}
