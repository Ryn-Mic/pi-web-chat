import type { ServerEvent } from "../shared/protocol.ts";

export type SequencedServerEvent = Extract<ServerEvent, { seq: number }>;

/**
 * Return events strictly after `afterSeq` when the retained window is complete.
 * Null means the caller must send a full snapshot baseline instead.
 */
export function selectReplayEvents(
  retained: readonly SequencedServerEvent[],
  currentSeq: number,
  afterSeq: number,
): SequencedServerEvent[] | null {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > currentSeq) return null;
  if (afterSeq === currentSeq) return [];

  const suffix = retained.filter((event) => event.seq > afterSeq);
  if (suffix.length === 0) return null;
  let expected = afterSeq + 1;
  for (const event of suffix) {
    if (event.seq !== expected) return null;
    expected += 1;
  }
  return expected - 1 === currentSeq ? suffix : null;
}
