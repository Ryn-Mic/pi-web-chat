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
    const height = Math.round(vv?.height ?? inner);
    const offsetTop = Math.round(vv?.offsetTop ?? 0);
    root.style.setProperty("--app-height", `${height}px`);
    root.style.setProperty("--app-top", `${offsetTop}px`);

    // Keyboard (or other overlay) shrank the visible viewport.
    const keyboardOpen = height < inner - 80 || offsetTop > 0;
    root.classList.toggle("ua-keyboard", keyboardOpen);
    if (keyboardOpen) {
      // Counteract iOS auto-scrolling the locked page.
      window.scrollTo(0, 0);
    }
  };

  const applyAll = () => {
    if (!document.body) return;
    applySafeAreas();
    applyHeight();
  };

  if (document.body) applyAll();
  else document.addEventListener("DOMContentLoaded", applyAll, { once: true });

  window.visualViewport?.addEventListener("resize", applyHeight);
  window.visualViewport?.addEventListener("scroll", applyHeight);
  window.addEventListener("resize", applyAll);
  window.addEventListener("orientationchange", () => {
    requestAnimationFrame(() => requestAnimationFrame(applyAll));
  });
  // iOS sometimes fires focus before the viewport resizes.
  window.addEventListener("focusin", () => {
    requestAnimationFrame(applyHeight);
    setTimeout(applyHeight, 300);
  });
  window.addEventListener("focusout", () => {
    setTimeout(applyAll, 100);
  });
}
