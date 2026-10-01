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
  const firstLoadedOrdinal = totalUserMessages - userIndices.length + 1;
  const localOrdinal = ordinal - firstLoadedOrdinal;
  return localOrdinal >= 0 && localOrdinal < userIndices.length
    ? userIndices[localOrdinal] ?? null
    : null;
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
