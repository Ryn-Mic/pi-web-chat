export const CODEX_SESSION_PREFIX = "codex:";

export function nativeCodexThreadId(id: string | null | undefined): string | undefined {
  return id?.startsWith(CODEX_SESSION_PREFIX)
    ? id.slice(CODEX_SESSION_PREFIX.length) || undefined
    : undefined;
}

export function nativeCodexSessionId(threadId: string): string {
  const normalized = threadId.trim();
  if (!normalized) throw new Error("Codex app-server returned an empty forked thread id");
  return CODEX_SESSION_PREFIX + normalized;
}

export interface CodexForkEntry<Client> {
  id: string;
  clients: Set<Client>;
  lastActive: number;
}

export interface CodexForkConnectionOptions<
  Client,
  Entry extends CodexForkEntry<Client>,
> {
  client: Client;
  source: Entry;
  bindings: Pick<Map<Client, Entry>, "set">;
  forkThread: () => Promise<string>;
  acquireEntry: (sessionId: string) => Promise<Entry>;
  /** Re-check the connection after the native RPC/hydration awaits complete. */
  canMoveClient?: () => boolean;
  sendSessionBound: (entry: Entry, sessionId: string) => void;
  sendFullSnapshot: (entry: Entry) => void;
  sendCommandCatalog: (entry: Entry) => void;
  sendForked: (entry: Entry) => void;
  now?: () => number;
}

/**
 * Fork one native Codex thread and move only the requesting connection.
 *
 * The old entry may have other browsers attached, so it must never be re-keyed
 * in place. The new native entry is hydrated before the binding changes, then
 * the browser receives one authoritative baseline under its canonical id.
 */
export async function forkCodexConnection<
  Client,
  Entry extends CodexForkEntry<Client>,
>(options: CodexForkConnectionOptions<Client, Entry>): Promise<{
  threadId: string;
  sessionId: string;
  entry: Entry;
}> {
  const threadId = (await options.forkThread()).trim();
  const sessionId = nativeCodexSessionId(threadId);
  const target = await options.acquireEntry(sessionId);
  if (target.id !== sessionId) {
    throw new Error(`Forked Codex thread bound to unexpected session id: ${target.id}`);
  }
  if (target === options.source) {
    throw new Error("Codex app-server returned the source thread for a fork");
  }
  if (options.canMoveClient && !options.canMoveClient()) {
    throw new Error("The requesting client disconnected before the Codex fork completed");
  }

  options.source.clients.delete(options.client);
  target.clients.add(options.client);
  options.bindings.set(options.client, target);
  const now = (options.now ?? Date.now)();
  options.source.lastActive = now;
  target.lastActive = now;

  // Ordering matters: ChatClient changes its URL/session identity first, then
  // installs a full baseline whose event sequence belongs to the new entry.
  options.sendSessionBound(target, sessionId);
  options.sendFullSnapshot(target);
  options.sendCommandCatalog(target);
  options.sendForked(target);

  return { threadId, sessionId, entry: target };
}
