import type { UIMessage, UISnapshot, UISnapshotDelta } from "./protocol.ts";

/** Find the first message whose stable server-side reference changed. */
export function firstChangedMessage(previous: UIMessage[], next: UIMessage[]): number {
  const shared = Math.min(previous.length, next.length);
  let index = 0;
  while (index < shared && previous[index] === next[index]) index += 1;
  return index;
}

/** Build a suffix replacement against a known snapshot revision. */
export function createSnapshotDelta(
  previous: UISnapshot,
  next: UISnapshot,
  baseRevision: number,
): UISnapshotDelta {
  const from = firstChangedMessage(previous.messages, next.messages);
  const { messages: _messages, ...snapshot } = next;
  return {
    baseRevision,
    revision: baseRevision + 1,
    from,
    messages: next.messages.slice(from),
    snapshot,
  };
}

/**
 * Apply a snapshot suffix only when it is based on the client's exact current
 * revision. A null result tells the caller to request a fresh full snapshot.
 */
export function applySnapshotDelta(
  current: UISnapshot | null,
  currentRevision: number | null,
  delta: UISnapshotDelta,
): UISnapshot | null {
  if (
    !current ||
    currentRevision !== delta.baseRevision ||
    !Number.isSafeInteger(delta.from) ||
    delta.from < 0 ||
    delta.from > current.messages.length
  ) {
    return null;
  }
  return {
    ...delta.snapshot,
    messages: [...current.messages.slice(0, delta.from), ...delta.messages],
  };
}
