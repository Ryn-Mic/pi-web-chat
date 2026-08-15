import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { UIHistoryPage } from "../shared/protocol.ts";
import { recordSessionMessageCompletions, serializeMessages } from "./serialize.ts";

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_PAGE_MESSAGES = 50;
const MAX_PAGE_MESSAGES = 200;

type SessionEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: unknown;
};

type HistoryCursor = {
  before: number;
  target: string;
};

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, fileSize: number): HistoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (
      !Number.isSafeInteger(parsed.before) ||
      (parsed.before as number) < 0 ||
      (parsed.before as number) > fileSize ||
      typeof parsed.target !== "string" ||
      parsed.target.length === 0 ||
      parsed.target.length > 256
    ) {
      throw new Error("invalid history cursor");
    }
    return parsed as HistoryCursor;
  } catch {
    throw new Error("invalid history cursor");
  }
}

function parseEntry(line: Buffer): SessionEntry | null {
  const text = line.toString("utf8").trim();
  if (!text) return null;
  try {
    const entry = JSON.parse(text) as SessionEntry;
    return entry && typeof entry === "object" && typeof entry.type === "string" ? entry : null;
  } catch {
    // A torn final line can be observed while another pi process is appending.
    return null;
  }
}

function isVisibleMessage(entry: SessionEntry): boolean {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;
  const role = (entry.message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || (typeof role === "string" && role !== "toolResult");
}

function isUserMessage(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    !!entry.message &&
    typeof entry.message === "object" &&
    (entry.message as { role?: unknown }).role === "user"
  );
}

/**
 * Read one active-branch page by walking complete JSONL lines backwards.
 *
 * The cursor carries both a byte boundary and the exact parent entry expected
 * next. That skips abandoned fork branches without loading or indexing the
 * whole file. A page closes on a user-message boundary so an assistant tool
 * call and its following toolResult are always serialized together.
 */
export function readSessionHistoryPage(
  file: string,
  options: { cursor?: string; limit?: number; leafId?: string | null } = {},
): UIHistoryPage {
  const fd = openSync(file, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const decoded = decodeCursor(options.cursor, fileSize);
    const hasLeafOverride = Object.prototype.hasOwnProperty.call(options, "leafId");
    if (!decoded && hasLeafOverride && options.leafId === null) {
      return { messages: [], cursor: null, hasMore: false };
    }
    const limit = Math.max(1, Math.min(MAX_PAGE_MESSAGES, options.limit ?? DEFAULT_PAGE_MESSAGES));
    let position = decoded?.before ?? fileSize;
    // Forward-ordered fragments of one line crossing chunk boundaries. Keeping
    // fragments avoids repeatedly copying multi-megabyte tool/image rows.
    let carry: Buffer[] = [];
    let started = decoded !== null || hasLeafOverride;
    let wantedParent: string | null = decoded?.target ?? options.leafId ?? null;
    let visibleMessages = 0;
    let oldestOffset = position;
    let done = false;
    const branchEntries: SessionEntry[] = [];

    const accept = (entry: SessionEntry, lineOffset: number) => {
      if (!started) {
        if (entry.type === "session" || typeof entry.id !== "string") return;
        started = true;
      } else {
        if (wantedParent === null || entry.id !== wantedParent) return;
      }

      branchEntries.push(entry);
      oldestOffset = lineOffset;
      wantedParent = typeof entry.parentId === "string" ? entry.parentId : null;
      if (isVisibleMessage(entry)) visibleMessages += 1;
      if (wantedParent === null || (visibleMessages >= limit && isUserMessage(entry))) {
        done = true;
      }
    };

    while (position > 0 && !done) {
      const start = Math.max(0, position - READ_CHUNK_BYTES);
      const chunk = Buffer.allocUnsafe(position - start);
      let bytesRead = 0;
      while (bytesRead < chunk.length) {
        const count = readSync(fd, chunk, bytesRead, chunk.length - bytesRead, start + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
      const data = chunk.subarray(0, bytesRead);
      let lineEnd = data.length;

      for (let i = lineEnd - 1; i >= 0 && !done; i -= 1) {
        if (data[i] !== 0x0a) continue;
        const lineStart = i + 1;
        const own = data.subarray(lineStart, lineEnd);
        const line = carry.length > 0 ? Buffer.concat([own, ...carry]) : own;
        carry = [];
        const entry = parseEntry(line);
        if (entry) accept(entry, start + lineStart);
        lineEnd = i;
      }

      if (!done && lineEnd > 0) carry.unshift(data.subarray(0, lineEnd));
      position = start;
      if (position === 0 && !done && carry.length > 0) {
        const entry = parseEntry(carry.length === 1 ? carry[0]! : Buffer.concat(carry));
        if (entry) accept(entry, 0);
      }
    }

    const orderedEntries = branchEntries.reverse();
    recordSessionMessageCompletions(orderedEntries);
    const messages = orderedEntries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    // Only expose another page when this read stopped deliberately at its
    // message limit. A missing/broken parent chain must not produce a cursor
    // that repeats the same empty scan forever.
    const cursor =
      done && wantedParent !== null
        ? encodeCursor({ before: oldestOffset, target: wantedParent })
        : null;
    return {
      messages: serializeMessages(messages),
      cursor,
      hasMore: cursor !== null,
    };
  } finally {
    closeSync(fd);
  }
}
