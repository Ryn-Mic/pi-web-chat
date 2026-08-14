import { StringDecoder } from "node:string_decoder";

type SessionEntry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  [key: string]: unknown;
};

type MutableSessionManager = {
  getLeafId(): string | null;
  getEntry(id: string): unknown;
  buildSessionContext(): { messages: unknown[] };
  fileEntries?: SessionEntry[];
  _buildIndex?: () => void;
};

type MutableAgentSession = {
  sessionManager: MutableSessionManager;
  agent: { state: { messages: unknown[] } };
};

export type ParsedAppend = {
  entries: SessionEntry[];
  pending: string;
};

/** Stateful UTF-8 decoder for byte ranges observed between file stat polls. */
export class AppendedJsonlDecoder {
  private pending = "";
  private decoder = new StringDecoder("utf8");

  push(chunk: Buffer): SessionEntry[] {
    const parsed = parseAppendedJsonl(this.pending, this.decoder.write(chunk));
    this.pending = parsed.pending;
    return parsed.entries;
  }
}

/** Parse complete JSONL rows while retaining a torn final append. */
export function parseAppendedJsonl(previousPending: string, chunk: string): ParsedAppend {
  const text = previousPending + chunk;
  const lines = text.split("\n");
  let pending = lines.pop() ?? "";
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as SessionEntry;
      if (entry && typeof entry === "object") entries.push(entry);
    } catch {
      // Match the SDK's tolerant loader: malformed complete rows are skipped.
    }
  }
  if (pending.trim()) {
    try {
      const entry = JSON.parse(pending.trim()) as SessionEntry;
      if (entry && typeof entry === "object") entries.push(entry);
      pending = "";
    } catch {
      // Another process may still be writing this final row.
    }
  }
  return { entries, pending };
}

export type ApplyExternalEntriesResult =
  | { status: "noop" }
  | { status: "applied"; count: number }
  | { status: "reload"; reason: string };

/**
 * Install externally appended entries without recreating AgentSessionRuntime.
 *
 * pi's SessionManager is append-only but does not expose an ingestion method.
 * Its emitted JavaScript keeps `fileEntries` and `_buildIndex` as ordinary
 * properties, so this adapter is deliberately defensive and returns `reload`
 * when that compatibility surface changes.
 */
export function applyExternalSessionEntries(
  value: unknown,
  appended: SessionEntry[],
): ApplyExternalEntriesResult {
  const session = value as Partial<MutableAgentSession>;
  const manager = session.sessionManager;
  if (
    !manager ||
    !session.agent?.state ||
    typeof manager.getLeafId !== "function" ||
    typeof manager.getEntry !== "function" ||
    typeof manager.buildSessionContext !== "function" ||
    !Array.isArray(manager.fileEntries) ||
    typeof manager._buildIndex !== "function"
  ) {
    return { status: "reload", reason: "unsupported SessionManager internals" };
  }

  const unknown = appended.filter(
    (entry): entry is SessionEntry & { id: string } =>
      typeof entry.id === "string" && !manager.getEntry(entry.id),
  );
  if (unknown.length === 0) return { status: "noop" };

  // AgentSession owns these live settings outside SessionManager context. A
  // full runtime reload remains the only correct way to apply them.
  if (
    unknown.some(
      (entry) => entry.type === "model_change" || entry.type === "thinking_level_change",
    )
  ) {
    return { status: "reload", reason: "external live-setting change" };
  }

  let parent = manager.getLeafId();
  for (const entry of unknown) {
    const entryParent = typeof entry.parentId === "string" ? entry.parentId : null;
    if (entryParent !== parent) {
      return { status: "reload", reason: "external parent chain diverged" };
    }
    parent = entry.id;
  }

  manager.fileEntries.push(...unknown);
  manager._buildIndex();
  session.agent.state.messages = manager.buildSessionContext().messages;
  return { status: "applied", count: unknown.length };
}
