import assert from "node:assert/strict";
import { test } from "node:test";
import { staticMimeType } from "../server/file-content.ts";

test("staticMimeType returns literal MIME for known preview asset extensions", () => {
  assert.equal(staticMimeType("/wasm/demo.wasm"), "application/wasm");
  assert.equal(staticMimeType("/worker.mjs"), "text/javascript");
  assert.equal(staticMimeType("/fonts/icon.woff"), "font/woff");
  assert.equal(staticMimeType("/fonts/icon.ttf"), "font/ttf");
  assert.equal(staticMimeType("/data/bundle.data"), "application/octet-stream");
});

test("staticMimeType falls back to application/octet-stream for unknown extensions", () => {
  assert.equal(staticMimeType("/something.xyz"), "application/octet-stream");
  assert.equal(staticMimeType("/no-ext"), "application/octet-stream");
});
