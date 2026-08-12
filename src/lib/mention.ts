/** Composer @-mention parsing (pure, unit-testable). */

export interface MentionQuery {
  /** Index of the "@" in text */
  start: number;
  /** Text between "@" and the caret */
  query: string;
}

/**
 * The caret sits inside an `@token` → its query, else null.
 * A token starts at the beginning of the text or after whitespace,
 * so email-like "a@b" never triggers.
 */
export function extractMentionQuery(text: string, caret: number): MentionQuery | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i]!)) i--;
  const start = i + 1;
  if (text[start] !== "@") return null;
  return { start, query: text.slice(start + 1, caret) };
}

/** Replace [start, caret) with insert and report the caret position after it. */
export function replaceMentionToken(
  text: string,
  start: number,
  caret: number,
  insert: string,
): { next: string; caret: number } {
  return { next: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
