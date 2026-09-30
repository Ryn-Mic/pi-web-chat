import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { Agent, createServer, request } from "node:http";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Writable, type Readable } from "node:stream";
import type { ResolvedPreviewFile } from "../server/files.ts";
import { sendResolvedFile, staticMimeType, streamStaticFile } from "../server/file-content.ts";

test("staticMimeType returns literal MIME for known asset extensions", () => {
  assert.equal(staticMimeType("/app.html"), "text/html");
  assert.equal(staticMimeType("/app.js"), "text/javascript");
  assert.equal(staticMimeType("/app.mjs"), "text/javascript");
  assert.equal(staticMimeType("/app.css"), "text/css");
  assert.equal(staticMimeType("/app.svg"), "image/svg+xml");
  assert.equal(staticMimeType("/app.png"), "image/png");
  assert.equal(staticMimeType("/app.ico"), "image/x-icon");
  assert.equal(staticMimeType("/app.json"), "application/json");
  assert.equal(staticMimeType("/app.map"), "application/json");
  assert.equal(staticMimeType("/app.wasm"), "application/wasm");
  assert.equal(staticMimeType("/app.woff"), "font/woff");
  assert.equal(staticMimeType("/app.woff2"), "font/woff2");
  assert.equal(staticMimeType("/app.ttf"), "font/ttf");
  assert.equal(staticMimeType("/app.otf"), "font/otf");
  assert.equal(staticMimeType("/app.data"), "application/octet-stream");
  assert.equal(staticMimeType("/app.webmanifest"), "application/manifest+json");
  assert.equal(staticMimeType("/song.mp3"), "audio/mpeg");
  assert.equal(staticMimeType("/song.wav"), "audio/wav");
  assert.equal(staticMimeType("/clip.mp4"), "video/mp4");
  assert.equal(staticMimeType("/clip.webm"), "video/webm");
  assert.equal(staticMimeType("/doc.pdf"), "application/pdf");
  assert.equal(staticMimeType("/doc.doc"), "application/msword");
  assert.equal(
    staticMimeType("/doc.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(staticMimeType("/sheet.xls"), "application/vnd.ms-excel");
  assert.equal(
    staticMimeType("/sheet.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(staticMimeType("/slides.ppt"), "application/vnd.ms-powerpoint");
  assert.equal(
    staticMimeType("/slides.pptx"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
});

test("staticMimeType falls back to application/octet-stream for unknown extensions", () => {
  assert.equal(staticMimeType("/something.xyz"), "application/octet-stream");
  assert.equal(staticMimeType("/no-ext"), "application/octet-stream");
});

test("streamStaticFile sets ETag and public cache headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-static-"));
  const filePath = join(dir, "viewer.wasm");
  writeFileSync(filePath, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  const server = createServer((req, res) => {
    streamStaticFile(req, res, filePath, { cacheControl: "public, max-age=3600, must-revalidate" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/viewer.wasm`;
  try {
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "application/wasm");
    assert.equal(head.headers.get("content-length"), "4");
    assert.ok(head.headers.get("etag"));
    assert.equal(head.headers.get("cache-control"), "public, max-age=3600, must-revalidate");
    assert.equal(head.headers.get("accept-ranges"), null);

    const get = await fetch(url);
    assert.equal(get.status, 200);
    assert.ok(get.headers.get("etag"));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function resolvedPreviewMeta(filePath: string): ResolvedPreviewFile {
  const st = statSync(filePath);
  return {
    abs: filePath,
    realAbs: filePath,
    path: "doc.txt",
    name: "doc.txt",
    size: st.size,
    mimeType: "text/plain",
    mtimeMs: st.mtimeMs,
    dev: Number(st.dev),
    ino: Number(st.ino),
    etag: `"${st.size}-${st.mtimeMs}"`,
  };
}

class FakeRequest extends EventEmitter {
  constructor(public method = "GET") {
    super();
  }
}

class FakeResponse extends Writable {
  chunks: Buffer[] = [];
  headers: Record<string, string | number | string[]> = {};
  statusCode?: number;
  headersSent = false;
  destroyed = false;

  setHeader(name: string, value: string | number | string[]) {
    this.headers[name] = value;
  }

  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
  }

  end(callback?: () => void): this;
  end(chunk: unknown, callback?: () => void): this;
  end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
    const cb = typeof encoding === "function" ? encoding : callback;
    super.end(chunk as never, typeof encoding === "string" ? encoding : undefined, cb);
    this.emit("finish");
    return this;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(chunk);
    callback();
  }

  override destroy(error?: Error) {
    this.destroyed = true;
    return super.destroy(error);
  }
}

class BlockingResponse extends FakeResponse {
  private readonly pendingWriteCallbacks: Array<() => void> = [];
  private resolveFirstWrite!: () => void;
  readonly firstWrite = new Promise<void>((resolve) => {
    this.resolveFirstWrite = resolve;
  });

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(chunk);
    this.pendingWriteCallbacks.push(callback);
    this.resolveFirstWrite();
  }

  flushPendingWrites() {
    for (const callback of this.pendingWriteCallbacks.splice(0)) {
      callback();
    }
  }
}

test("sendResolvedFile removes own listeners after successful GET response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-send-"));
  const filePath = join(dir, "doc.txt");
  writeFileSync(filePath, "hello world");

  const req = new FakeRequest("GET");
  const res = new FakeResponse();

  sendResolvedFile(req, res, resolvedPreviewMeta(filePath));

  // Wait for the stream to finish piping into the fake response.
  const onFinish = () => {};
  const onError = () => {};
  await new Promise<void>((resolve, reject) => {
    res.once("finish", () => {
      res.removeListener("finish", onFinish);
      res.removeListener("error", onError);
      resolve();
    });
    res.once("error", reject);
  });

  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.chunks).toString(), "hello world");

  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("finish"), 0);

  rmSync(dir, { recursive: true, force: true });
});

for (const initialContent of ["hello", ""]) {
  test(`sendResolvedFile bounds a ${initialContent.length}-byte response when its open file grows`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-send-growth-"));
    const filePath = join(dir, "doc.txt");
    writeFileSync(filePath, initialContent);
    const req = new FakeRequest("GET");
    const res = new FakeResponse();
    const finished = new Promise<void>((resolve, reject) => {
      res.once("finish", resolve);
      res.once("error", reject);
    });
    try {
      sendResolvedFile(req, res, resolvedPreviewMeta(filePath), {
        // The descriptor has passed metadata validation, but no read has begun.
        onReady: () => appendFileSync(filePath, "added after open"),
      });
      await finished;
      assert.equal(res.headers["content-length"], String(initialContent.length));
      assert.equal(Buffer.concat(res.chunks).toString(), initialContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("sendResolvedFile preserves keepalive on growth and closes it on truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-keepalive-growth-"));
  const filePath = join(dir, "doc.txt");
  writeFileSync(filePath, "hello");
  let requests = 0;
  const server = createServer((req, res) => {
    const currentRequest = requests++;
    if (currentRequest === 0) {
      sendResolvedFile(req, res, resolvedPreviewMeta(filePath), {
        onReady: () => appendFileSync(filePath, "ed"),
      });
    } else if (currentRequest === 2) {
      sendResolvedFile(req, res, resolvedPreviewMeta(filePath), {
        onReady: () => writeFileSync(filePath, "hi"),
      });
    } else {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "content changed" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise<{ status: number; text: string; reused: boolean }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}`, { agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => resolve({
        status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), reused: req.reusedSocket,
      }));
    });
    req.once("error", reject);
    req.end();
  });
  try {
    assert.deepEqual(await get(), { status: 200, text: "hello", reused: false });
    assert.deepEqual(await get(), { status: 409, text: '{"error":"content changed"}', reused: true });
    await assert.rejects(get(), { code: "ECONNRESET" });
    assert.deepEqual(await get(), { status: 409, text: '{"error":"content changed"}', reused: false });
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendResolvedFile destroys an incomplete response when its open file truncates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-send-truncation-"));
  const filePath = join(dir, "doc.txt");
  writeFileSync(filePath, "hello");
  const req = new FakeRequest("GET");
  const res = new FakeResponse();
  const closed = new Promise<void>((resolve) => res.once("close", resolve));
  try {
    sendResolvedFile(req, res, resolvedPreviewMeta(filePath), {
      onReady: () => writeFileSync(filePath, "hi"),
    });
    await closed;
    assert.equal(res.headers["content-length"], "5");
    assert.equal(Buffer.concat(res.chunks).toString(), "hi");
    assert.equal(res.destroyed, true);
    assert.equal(res.writableEnded, false);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(req.listenerCount("close"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const initialContent of ["hello", ""]) {
  test(`streamStaticFile bounds a ${initialContent.length}-byte response when its open file grows`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-static-growth-"));
    const filePath = join(dir, "asset.txt");
    writeFileSync(filePath, initialContent);
    const req = new FakeRequest("GET");
    class GrowingResponse extends FakeResponse {
      override writeHead(status: number) {
        appendFileSync(filePath, "added after open");
        super.writeHead(status);
      }
    }
    const res = new GrowingResponse();
    const finished = new Promise<void>((resolve, reject) => {
      res.once("finish", resolve);
      res.once("error", reject);
    });
    try {
      streamStaticFile(req, res, filePath);
      await finished;
      assert.equal(res.headers["content-length"], String(initialContent.length));
      assert.equal(Buffer.concat(res.chunks).toString(), initialContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("sendResolvedFile opens fd before HEAD onReady and removes own listeners", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-send-"));
  const filePath = join(dir, "doc.txt");
  writeFileSync(filePath, "hello world");

  const req = new FakeRequest("HEAD");
  const res = new FakeResponse();
  let readyCalled = false;

  sendResolvedFile(req, res, resolvedPreviewMeta(filePath), {
    onReady: () => {
      readyCalled = true;
    },
  });

  assert.equal(readyCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.chunks).toString(), "");

  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("finish"), 0);
  assert.equal(res.listenerCount("error"), 0);

  rmSync(dir, { recursive: true, force: true });
});

test("sendResolvedFile does not call onReady when fd open fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-send-"));
  const filePath = join(dir, "doc.txt");
  writeFileSync(filePath, "hello world");
  const meta = resolvedPreviewMeta(filePath);
  rmSync(filePath, { force: true });

  const req = new FakeRequest("GET");
  const res = new FakeResponse();
  let readyCalled = false;

  assert.throws(() => {
    sendResolvedFile(req, res, meta, {
      onReady: () => {
        readyCalled = true;
      },
    });
  }, { code: "ENOENT" });
  assert.equal(readyCalled, false);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.headersSent, false);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("finish"), 0);

  rmSync(dir, { recursive: true, force: true });
});

test("sendResolvedFile does not send 200 when onReady throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-send-"));
  const filePath = join(dir, "doc.txt");
  writeFileSync(filePath, "hello world");

  const req = new FakeRequest("GET");
  const res = new FakeResponse();

  assert.throws(() => {
    sendResolvedFile(req, res, resolvedPreviewMeta(filePath), {
      onReady: () => {
        throw new Error("consume failed");
      },
    });
  }, /consume failed/);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.headersSent, false);
  assert.deepEqual(res.headers, {});
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("finish"), 0);

  rmSync(dir, { recursive: true, force: true });
});

test("sendResolvedFile detaches and destroys stream on request abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-send-"));
  const filePath = join(dir, "big.bin");
  const chunk = Buffer.alloc(64 * 1024, "a");
  writeFileSync(filePath, Buffer.concat(Array.from({ length: 64 }, () => chunk)));

  const req = new FakeRequest("GET");
  const res = new BlockingResponse();
  const baseline = {
    reqAborted: req.listenerCount("aborted"),
    reqClose: req.listenerCount("close"),
    resClose: res.listenerCount("close"),
    resFinish: res.listenerCount("finish"),
    resError: res.listenerCount("error"),
  };
  const sourceReady = new Promise<Readable>((resolve) => {
    res.once("pipe", resolve);
  });

  try {
    sendResolvedFile(req, res, resolvedPreviewMeta(filePath));
    const source = await sourceReady;
    await res.firstWrite;

    const sourceClosed = new Promise<void>((resolve) => {
      source.once("close", resolve);
    });
    const sourceUnpiped = new Promise<void>((resolve) => {
      res.once("unpipe", resolve);
    });

    req.emit("aborted");
    assert.doesNotThrow(() => source.emit("error", new Error("late read failure")));
    res.flushPendingWrites();
    await Promise.all([sourceClosed, sourceUnpiped]);

    assert.equal(req.listenerCount("aborted"), baseline.reqAborted);
    assert.equal(req.listenerCount("close"), baseline.reqClose);
    assert.equal(res.listenerCount("close"), baseline.resClose);
    assert.equal(res.listenerCount("finish"), baseline.resFinish);
    assert.equal(res.listenerCount("error"), baseline.resError);
  } finally {
    res.flushPendingWrites();
    rmSync(dir, { recursive: true, force: true });
  }
});
