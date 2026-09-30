import type { UIMessage } from "../../shared/protocol";

const legacyKeys = new WeakMap<UIMessage, string>();

function legacyMessageKey(message: UIMessage): string {
  const cached = legacyKeys.get(message);
  if (cached) return cached;
  const value = JSON.stringify([message.role, message.timestamp, message.content]);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  const key = `legacy:${hash >>> 0}`;
  legacyKeys.set(message, key);
  return key;
}

/** New servers supply ids. Older servers retain identity when history prepends. */
export function messageKeys(messages: UIMessage[]): string[] {
  const keys = new Array<string>(messages.length);
  const occurrences = new Map<string, number>();
  // Count duplicate legacy content from the tail so prepends preserve newer rows.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.id) {
      keys[index] = message.id;
      continue;
    }
    const base = legacyMessageKey(message);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    keys[index] = `${base}:${occurrence}`;
  }
  return keys;
}
