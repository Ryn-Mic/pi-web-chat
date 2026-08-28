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
