/**
 * Shared visual/interaction primitives for dialogs, palettes and buttons.
 *
 * These constants exist so the same surface (modal backdrop, centered popup,
 * composer-anchored palette, primary/secondary action buttons) renders and
 * behaves identically no matter which component opens it. Extend here instead
 * of re-inlining class strings when a new dialog or palette is added.
 */

/**
 * Modal backdrop. Every base-ui Dialog uses this exact mask so dimming feels
 * consistent across settings, extensions, fork, models and the drawers.
 */
export const DIALOG_BACKDROP_CLASS =
  "fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";

/**
 * Centered modal surface (base-ui Dialog.Popup). Anchor variants that need a
 * different position (side drawers, bottom sheets) intentionally do not use it.
 */
export const DIALOG_POPUP_CLASS =
  "fixed top-1/2 left-1/2 flex max-h-[75vh] w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-card shadow-xl outline-none";

/**
 * Composer-anchored palette surface (command palette, file mentions). The
 * popup is absolutely positioned above the composer input.
 */
export const PALETTE_POPUP_CLASS =
  "absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-lg border border-line bg-card shadow-lg";

/** Primary action button (confirm, send, save). */
export const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

/** Secondary action button (cancel, dismiss, alternative choices). */
export const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-line px-4 py-2 text-sm text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";
