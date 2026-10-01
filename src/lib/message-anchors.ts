import type { UIMessage } from "../../shared/protocol";

/**
 * Map a global one-based user-message ordinal to the currently loaded suffix.
 * Persisted pages are always prepended, so loaded user messages form a
 * contiguous suffix of the server's lightweight anchor index.
 */
export function messageIndexForUserOrdinal(
  messages: readonly UIMessage[],
  totalUserMessages: number,
  ordinal: number,
): number | null {
  if (!Number.isSafeInteger(totalUserMessages) || !Number.isSafeInteger(ordinal)) return null;
  if (ordinal < 1 || ordinal > totalUserMessages) return null;

  const userIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") userIndices.push(index);
  });
  const firstLoadedOrdinal = firstLoadedUserOrdinal(totalUserMessages, userIndices.length);
  const localOrdinal = ordinal - firstLoadedOrdinal;
  return localOrdinal >= 0 && localOrdinal < userIndices.length
    ? userIndices[localOrdinal] ?? null
    : null;
}

/**
 * Global one-based ordinal of the first user message in the loaded suffix.
 * Every ordinal the UI renders (ticks, flyout labels, highlight) must be global,
 * otherwise a transcript that starts mid-conversation is labelled by its local
 * position and stops corresponding to the message on screen.
 */
export function firstLoadedUserOrdinal(
  totalUserMessages: number,
  loadedUserMessages: number,
): number {
  if (!Number.isSafeInteger(totalUserMessages) || !Number.isSafeInteger(loadedUserMessages)) return 1;
  return Math.max(1, totalUserMessages - loadedUserMessages + 1);
}

/**
 * How far below the viewport's top edge a user message may sit and still count
 * as the one the viewport is anchored to. Must stay >= the scroll-margin the
 * message carries (`scroll-mt-4` on the user bubble) so a prompt pinned to the
 * top by `scrollIntoView({ block: "start" })` reads back as itself.
 */
export const VIEWPORT_ANCHOR_TOLERANCE_PX = 24;

/**
 * The user message a viewport is anchored to: the last one whose top edge has
 * reached the top of the viewport, in document order. Prompts below the fold
 * never win, so the prompt just scrolled to stays current while its answer is
 * read. Returning `null` means no prompt has reached the top edge yet.
 */
export function viewportUserOrdinal(
  offsets: readonly { ordinal: number; top: number }[],
  tolerance = VIEWPORT_ANCHOR_TOLERANCE_PX,
): number | null {
  let anchored: number | null = null;
  for (const { ordinal, top } of offsets) {
    if (!Number.isFinite(top) || top > tolerance) continue;
    anchored = ordinal;
  }
  return anchored;
}

/**
 * Compute the visible tick ordinals (1-based) constrained to at most `maxTicks`.
 * Dynamically slides a centered window around `currentOrdinal` when total exceeds `maxTicks`.
 */
export function computeVisibleTicks(
  totalCount: number,
  currentOrdinal: number,
  maxTicks = 7,
): number[] {
  if (!Number.isSafeInteger(totalCount) || totalCount <= 0) return [];
  if (totalCount <= maxTicks) {
    return Array.from({ length: totalCount }, (_, i) => i + 1);
  }

  const safeCurrent = Math.max(1, Math.min(totalCount, currentOrdinal));
  const half = Math.floor(maxTicks / 2);
  let start = safeCurrent - half;
  let end = safeCurrent + (maxTicks - 1 - half);

  if (start < 1) {
    start = 1;
    end = maxTicks;
  } else if (end > totalCount) {
    end = totalCount;
    start = totalCount - maxTicks + 1;
  }

  const ticks: number[] = [];
  for (let i = start; i <= end; i++) {
    ticks.push(i);
  }
  return ticks;
}
