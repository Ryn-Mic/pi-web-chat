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

  const applySafeAreas = () => {
    const top = Math.min(Math.max(measureEnvPadding("top"), 0), SAFE_TOP_MAX);
    const bottom = Math.min(Math.max(measureEnvPadding("bottom"), 0), SAFE_BOTTOM_MAX);
    root.style.setProperty("--safe-top", `${top}px`);
    root.style.setProperty("--safe-bottom", `${bottom}px`);
  };

  const applyHeight = () => {
    const vv = window.visualViewport;
    const inner = window.innerHeight;
    const vvHeight = Math.round(vv?.height ?? inner);
    const offsetTop = Math.round(vv?.offsetTop ?? 0);

    // Keyboard (or other overlay) shrank the visible viewport. The offsetTop
    // threshold tolerates tiny iOS scroll jitter so we don't flip-flop.
    const keyboardOpen = vvHeight < inner - 80 || offsetTop > 4;

    if (keyboardOpen) {
      // Keyboard covers the layout viewport: shrink the app to the visible area.
      root.style.setProperty("--app-height", `${vvHeight}px`);
      root.classList.add("ua-keyboard");
      // Counteract iOS auto-scrolling the locked page.
      if (window.scrollY > 0) window.scrollTo(0, 0);
    } else {
      // No keyboard: fall back to CSS height:100% (body is fixed inset:0, so
      // this is the layout viewport — reliable in iOS standalone, unlike JS
      // viewport numbers which can under-report and leave dead space below
      // the composer).
      root.style.removeProperty("--app-height");
      root.classList.remove("ua-keyboard");
    }
    root.style.setProperty("--app-top", `${offsetTop}px`);
  };

  // Throttle visualViewport resize/scroll storms (iOS fires these constantly
  // while scrolling or during keyboard animations) to one write per frame.
  let pendingHeight = false;
  const scheduleHeight = () => {
    if (pendingHeight) return;
    pendingHeight = true;
    requestAnimationFrame(() => {
      pendingHeight = false;
      applyHeight();
    });
  };

  const applyAll = () => {
    if (!document.body) return;
    applySafeAreas();
    applyHeight();
  };

  let pendingAll = false;
  const scheduleAll = () => {
    if (pendingAll) return;
    pendingAll = true;
    requestAnimationFrame(() => {
      pendingAll = false;
      applyAll();
    });
  };

  if (document.body) applyAll();
  else document.addEventListener("DOMContentLoaded", applyAll, { once: true });

  // iOS standalone can report a wrong viewport height right at load (before the
  // layout viewport settles), and no resize event follows. Re-measure a couple
  // of times after load so the composer isn't left floating above dead space.
  const stabilize = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(applyAll);
      setTimeout(applyAll, 300);
    });
  };
  window.addEventListener("load", stabilize, { once: true });
  setTimeout(stabilize, 1_000);

  window.visualViewport?.addEventListener("resize", scheduleHeight);
  window.visualViewport?.addEventListener("scroll", scheduleHeight);
  window.addEventListener("resize", scheduleAll);
  window.addEventListener("orientationchange", () => {
    requestAnimationFrame(() => requestAnimationFrame(applyAll));
  });
  // iOS sometimes fires focus before the viewport resizes.
  window.addEventListener("focusin", () => {
    scheduleHeight();
    setTimeout(applyHeight, 300);
  });
  window.addEventListener("focusout", () => {
    setTimeout(applyAll, 100);
  });
}
