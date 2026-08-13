import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { staticMimeType, streamStaticFile } from "../server/file-content.ts";

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
