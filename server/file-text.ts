import { constants } from "node:fs";
import { assertPublicFileIdentity, assertPublicFilePath } from "./private-paths.ts";
import { access, lstat, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { MAX_TEXT_BYTES, decodeTextBytes } from "../shared/text-file.ts";
import { PathEscapeError, PreviewTooLargeError, resolvePreviewFile } from "./files.ts";
import type { PreviewRequestDeps } from "./file-content.ts";
import type { UITextFileSnapshot } from "../shared/protocol.ts";

class TextFileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type TextFileSnapshot = UITextFileSnapshot;

const saves = new Map<string, Promise<unknown>>();
const revisionOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readText(root: string, path: string) {
  const meta = resolvePreviewFile(root, path, { sourceText: true });
  if (meta.size > MAX_TEXT_BYTES) throw new TextFileError(413, "file too large");
  // Reading a link inside the workspace is allowed; saving one is not.
  const fd = await open(meta.realAbs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    assertPublicFilePath(meta.realAbs);
    assertPublicFileIdentity(st);
    if (!st.isFile() || st.dev !== meta.dev || st.ino !== meta.ino) throw new TextFileError(409, "content changed");
    if (st.size > MAX_TEXT_BYTES) throw new TextFileError(413, "file too large");
    // Bound reads even when another process appends after stat().
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_TEXT_BYTES) throw new TextFileError(413, "file too large");
    const bytes = buffer.subarray(0, length);
    const text = decodeTextBytes(bytes);
    if (text === null) throw new TextFileError(415, "not a UTF-8 text file");
    return { meta, st, snapshot: { text, revision: revisionOf(bytes), name: meta.name } };
  } finally { await fd.close(); }
}

/** Existing files only; serialize this server's conditional saves for a path. */
export async function saveTextFile(root: string, path: string, text: string, revision: string): Promise<TextFileSnapshot> {
  const key = resolvePreviewFile(root, path, { sourceText: true }).abs;
  const previous = saves.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_TEXT_BYTES) throw new TextFileError(413, "file too large");
    if (decodeTextBytes(bytes) !== text) throw new TextFileError(415, "invalid text content");
    const current = await readText(root, path);
    const lst = await lstat(current.meta.abs);
    if (!lst.isFile() || lst.nlink !== 1) throw new TextFileError(415, "linked files are read-only");
    if (!(lst.mode & 0o222)) throw new TextFileError(403, "file is read-only");
    await access(current.meta.abs, constants.W_OK);
    if (current.snapshot.revision !== revision) throw new TextFileError(409, "content changed");
    const temp = join(dirname(current.meta.abs), `.pi-web-edit-${randomUUID()}.tmp`);
    try {
      const fd = await open(temp, "wx", current.st.mode & 0o777);
      try {
        await fd.writeFile(bytes);
        await fd.chown(current.st.uid, current.st.gid);
        await fd.chmod(current.st.mode & 0o777);
        await fd.sync();
      } finally { await fd.close(); }
      // Re-resolve authorization/path and revision immediately before replacing.
      const latest = await readText(root, path);
      const latestLink = await lstat(latest.meta.abs);
      if (!latestLink.isFile() || latestLink.nlink !== 1 || latest.st.dev !== current.st.dev ||
          latest.st.ino !== current.st.ino || latestLink.dev !== latest.st.dev || latestLink.ino !== latest.st.ino ||
          latestLink.mode !== current.st.mode || latestLink.uid !== current.st.uid || latestLink.gid !== current.st.gid ||
          latest.snapshot.revision !== revision) {
        throw new TextFileError(409, "content changed");
      }
      await access(latest.meta.abs, constants.W_OK);
      await rename(temp, latest.meta.abs);
      return { text, revision: revisionOf(bytes), name: current.meta.name };
    } finally { await unlink(temp).catch(() => undefined); }
  });
  saves.set(key, operation);
  try { return await operation; }
  finally { if (saves.get(key) === operation) saves.delete(key); }
}

async function readPayload(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    // JSON escaping can expand a valid 2 MiB UTF-8 text by up to six times.
    if (size > MAX_TEXT_BYTES * 6 + 1024) throw new TextFileError(413, "request too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TextFileError(400, "invalid JSON"); }
}

/** Called only after the server's authenticated API gate. */
export async function handleTextFileRequest(req: IncomingMessage, res: ServerResponse, url: URL, deps: PreviewRequestDeps): Promise<boolean> {
  if (url.pathname !== "/api/files/text") return false;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "GET" && req.method !== "PUT") throw new TextFileError(405, "method not allowed");
    const cwd = url.searchParams.get("cwd") ?? "";
    const path = url.searchParams.get("path") ?? "";
    if (!cwd || !path || path.includes("\0")) throw new TextFileError(400, "cwd and path are required");
    const root = deps.expandHome(cwd);
    if (!(await deps.knownProjectRoots()).has(root)) throw new TextFileError(403, "unknown project cwd");
    if (req.method === "GET") send(200, (await readText(root, path)).snapshot);
    else {
      if (!req.headers.authorization?.startsWith("Bearer ")) throw new TextFileError(401, "session bearer required");
      if (!req.headers["content-type"]?.startsWith("application/json")) throw new TextFileError(415, "JSON required");
      const body = await readPayload(req);
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" ||
          !("revision" in body) || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
        throw new TextFileError(400, "text and revision are required");
      }
      send(200, await saveTextFile(root, path, body.text, body.revision));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof TextFileError) send(error.status, { error: error.message });
    else if (error instanceof PathEscapeError) send(400, { error: "invalid path" });
    else if (error instanceof PreviewTooLargeError) send(413, { error: "file too large" });
    else if (code === "ENOENT" || code === "ENOTDIR") send(404, { error: "not found" });
    else if (code === "EACCES" || code === "EPERM" || code === "ELOOP") send(403, { error: "forbidden" });
    else send(500, { error: "file operation failed" });
  }
  return true;
}
