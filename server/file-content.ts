import { closeSync, createReadStream, fstatSync, openSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import {
  openResolvedPreviewFile,
  PathEscapeError,
  PreviewTooLargeError,
  PreviewUnsupportedError,
  resolvePreviewFile,
  type ResolvedPreviewFile,
} from "./files.ts";

export interface PreviewRequestDeps {
  knownProjectRoots(): Promise<Set<string>>;
  expandHome(path: string): string;
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".data": "application/octet-stream",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function staticMimeType(pathname: string): string {
  return STATIC_MIME[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

interface StaticOptions {
  cacheControl?: string;
}

const INTERNAL_ERROR_TEXT = "internal server error";
const INTERNAL_ERROR_JSON = { error: INTERNAL_ERROR_TEXT };

function destroyReadStream(stream: ReturnType<typeof createReadStream>): void {
  // An in-flight fs read can report an error after HTTP listeners are detached.
  stream.once("error", () => {});
  stream.destroy();
}

function pipeContentStream(
  req: IncomingMessage,
  res: ServerResponse,
  stream: ReturnType<typeof createReadStream>,
  expectedBytes: number,
): void {
  if (req.aborted || res.writableEnded || res.destroyed) {
    destroyReadStream(stream);
    return;
  }
  if (req.method === "HEAD" || expectedBytes === 0) {
    destroyReadStream(stream);
    res.writeHead(200);
    res.end();
    return;
  }

  let sentBytes = 0;
  const detach = () => {
    req.removeListener("aborted", onRequestClose);
    req.removeListener("close", onRequestClose);
    res.removeListener("close", cleanup);
    res.removeListener("finish", cleanup);
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
  };
  const cleanup = () => {
    detach();
    stream.unpipe(res);
    destroyReadStream(stream);
  };
  const onRequestClose = () => {
    cleanup();
    // A response with an incomplete Content-Length cannot reuse its connection.
    res.destroy();
  };
  const onData = (chunk: Buffer | string) => {
    sentBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  };
  const onEnd = () => {
    if (sentBytes !== expectedBytes) {
      cleanup();
      res.destroy();
    } else {
      res.end();
    }
  };
  const onError = () => {
    cleanup();
    res.destroy();
  };

  req.once("aborted", onRequestClose);
  req.once("close", onRequestClose);
  res.once("close", cleanup);
  res.once("finish", cleanup);
  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("error", onError);
  // Keep the error listener until the descriptor closes, including after abort.
  stream.once("close", () => stream.removeListener("error", onError));
  try {
    res.writeHead(200);
    // Node's pipe end listener can already be queued when we detect a short
    // read. End only after our own byte-count check, never via pipe's listener.
    stream.pipe(res, { end: false });
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function streamStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options?: StaticOptions,
): void {
  let stream: ReturnType<typeof createReadStream> | undefined;
  let fd: number | undefined;

  try {
    fd = openSync(filePath, "r");
    // Headers and reads must describe the same open file, even after replacement.
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      fd = undefined;
      sendPlain(res, 404, "Not found");
      return;
    }

    const headers: Record<string, string> = {
      "content-type": staticMimeType(filePath),
      "content-length": String(st.size),
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "last-modified": new Date(st.mtimeMs).toUTCString(),
      etag: `W/"${st.size}-${st.mtimeMs}"`,
    };
    if (options?.cacheControl) headers["cache-control"] = options.cacheControl;

    stream = createReadStream(filePath, {
      fd, autoClose: true, start: 0,
      ...(st.size > 0 ? { end: st.size - 1 } : {}),
    });
    fd = undefined; // The stream now owns the descriptor.
    if (st.size === 0) stream.push(null);
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    pipeContentStream(req, res, stream, st.size);
  } catch (err) {
    if (stream) destroyReadStream(stream);
    if (fd !== undefined) closeSync(fd);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.removeHeader("content-length");
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      sendPlain(res, 404, "Not found");
    } else if (code === "EACCES") {
      sendPlain(res, 403, "Forbidden");
    } else {
      sendPlain(res, 500, INTERNAL_ERROR_TEXT);
    }
  }
}

function sendPlain(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "text/plain" });
  }
  res.end(message);
}

export function setContentHeaders(res: ServerResponse, meta: ResolvedPreviewFile): void {
  res.setHeader("content-type", meta.mimeType);
  res.setHeader("content-length", String(meta.size));
  res.setHeader("etag", meta.etag);
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("last-modified", new Date(meta.mtimeMs).toUTCString());
}

export interface SendResolvedFileOptions {
  extraHeaders?: Record<string, string>;
  onReady?: () => void;
}

export function sendResolvedFile(
  req: IncomingMessage,
  res: ServerResponse,
  meta: ResolvedPreviewFile,
  options?: SendResolvedFileOptions,
): void {
  let stream: ReturnType<typeof createReadStream> | undefined;

  try {
    const fdResult = openResolvedPreviewFile(meta);
    stream = fdResult.stream;

    // A failed one-time capability check must leave no file framing headers on
    // the caller's JSON error response.
    options?.onReady?.();
    setContentHeaders(res, meta);
    if (options?.extraHeaders) {
      for (const [key, value] of Object.entries(options.extraHeaders)) {
        res.setHeader(key, value);
      }
    }
    pipeContentStream(req, res, stream, meta.size);
  } catch (err) {
    if (stream) destroyReadStream(stream);
    throw err;
  }
}

export async function handleDesktopFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PreviewRequestDeps,
): Promise<boolean> {
  if (url.pathname !== "/api/files/content") return false;

  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(405, { error: "method not allowed" });
    return true;
  }

  const rawCwd = url.searchParams.get("cwd") ?? "";
  const rel = url.searchParams.get("path") ?? "";
  if (!rawCwd || !rel) {
    sendJson(400, { error: "cwd and path are required" });
    return true;
  }

  const root = deps.expandHome(rawCwd);
  if (!(await deps.knownProjectRoots()).has(root)) {
    sendJson(403, { error: "unknown project cwd" });
    return true;
  }

  let meta: ResolvedPreviewFile;
  try {
    meta = resolvePreviewFile(root, rel);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      sendJson(400, { error: "invalid path" });
      return true;
    }
    if (err instanceof PreviewTooLargeError) {
      sendJson(413, { error: "file too large" });
      return true;
    }
    if (err instanceof PreviewUnsupportedError) {
      sendJson(415, { error: "unsupported file" });
      return true;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      sendJson(404, { error: "not found" });
      return true;
    }
    if (code === "EACCES") {
      sendJson(403, { error: "forbidden" });
      return true;
    }
    sendJson(500, INTERNAL_ERROR_JSON);
    return true;
  }

  const ifMatch = req.headers["if-match"];
  if (req.method === "GET" && (!ifMatch || ifMatch !== meta.etag)) {
    sendJson(409, { error: "content changed" });
    return true;
  }

  try {
    sendResolvedFile(req, res, meta);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESTALE") {
      sendJson(409, { error: "content changed" });
      return true;
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      sendJson(404, { error: "not found" });
      return true;
    }
    if (code === "EACCES") {
      sendJson(403, { error: "forbidden" });
      return true;
    }
    sendJson(500, INTERNAL_ERROR_JSON);
    return true;
  }
  return true;
}
