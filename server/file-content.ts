import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import {
  openResolvedPreviewFile,
  PathEscapeError,
  PreviewTooLargeError,
  resolvePreviewFile,
  type ResolvedPreviewFile,
} from "./files.ts";

export interface PreviewRequestDeps {
  knownProjectRoots(): Promise<Set<string>>;
  expandHome(path: string): string;
}

const STATIC_MIME: Record<string, string> = {
  ".wasm": "application/wasm",
  ".mjs": "text/javascript",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".data": "application/octet-stream",
};

export function staticMimeType(pathname: string): string {
  return STATIC_MIME[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

interface StaticOptions {
  cacheControl?: string;
}

export function streamStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options?: StaticOptions,
): void {
  let stream: ReturnType<typeof createReadStream> | undefined;
  const cleanup = () => {
    stream?.destroy();
    stream = undefined;
  };
  req.once("aborted", cleanup);
  res.once("close", cleanup);

  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      sendPlain(res, 404, "Not found");
      return;
    }

    const headers: Record<string, string> = {
      "content-type": staticMimeType(filePath),
      "content-length": String(st.size),
      "accept-ranges": "bytes",
      "last-modified": new Date(st.mtimeMs).toUTCString(),
      etag: `W/"${st.size}-${st.mtimeMs}"`,
    };
    if (options?.cacheControl) headers["cache-control"] = options.cacheControl;

    res.writeHead(200, headers);
    stream = createReadStream(filePath);
    stream.on("error", (err) => {
      cleanup();
      if (!res.writableEnded) res.end(`stream error: ${err.message}`);
    });
    stream.pipe(res);
  } catch (err) {
    cleanup();
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      sendPlain(res, 404, "Not found");
    } else if (code === "EACCES") {
      sendPlain(res, 403, "Forbidden");
    } else {
      sendPlain(res, 500, "Internal server error");
    }
  }
}

function sendPlain(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "text/plain" });
  }
  res.end(message);
}

function setContentHeaders(res: ServerResponse, meta: ResolvedPreviewFile): void {
  res.setHeader("content-type", meta.mimeType);
  res.setHeader("content-length", String(meta.size));
  res.setHeader("etag", meta.etag);
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("last-modified", new Date(meta.mtimeMs).toUTCString());
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
  const rawPath = url.searchParams.get("path") ?? "";
  if (!rawCwd || !rawPath) {
    sendJson(400, { error: "cwd and path are required" });
    return true;
  }

  const root = deps.expandHome(rawCwd);
  if (!(await deps.knownProjectRoots()).has(root)) {
    sendJson(403, { error: "unknown project cwd" });
    return true;
  }

  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    sendJson(400, { error: "invalid path encoding" });
    return true;
  }

  let meta: ResolvedPreviewFile;
  try {
    meta = resolvePreviewFile(root, rel);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      sendJson(400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    if (err instanceof PreviewTooLargeError) {
      sendJson(413, { error: "file too large" });
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
    sendJson(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  if (req.method === "HEAD") {
    setContentHeaders(res, meta);
    res.writeHead(200);
    res.end();
    return true;
  }

  const ifMatch = req.headers["if-match"];
  if (!ifMatch || ifMatch !== meta.etag) {
    sendJson(409, { error: "content changed" });
    return true;
  }

  let fdResult: ReturnType<typeof openResolvedPreviewFile>;
  try {
    fdResult = openResolvedPreviewFile(meta);
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
    sendJson(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  let stream = fdResult.stream;
  const cleanup = () => {
    stream.destroy();
    stream.removeAllListeners();
  };
  req.once("aborted", cleanup);
  res.once("close", cleanup);
  stream.on("error", (err) => {
    cleanup();
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: err.message }));
  });

  setContentHeaders(res, meta);
  res.writeHead(200);
  stream.pipe(res);
  return true;
}
