import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumePreviewContextFromHash,
  createPreviewFrameSrc,
  isPreviewFrameMessage,
  loadFramePreviewFile,
} from "../src/lib/file-preview-frame.ts";

test("frame src contains only an opaque fragment capability", () => {
  const src = createPreviewFrameSrc("opaque/id");
  assert.equal(src, "/file-preview.html#context=opaque%2Fid");
  assert.equal(src.includes("cwd="), false);
  assert.equal(src.includes("path="), false);
  assert.equal(src.includes("token="), false);
});

test("message guard requires exact origin, source and type", () => {
  const expectedWindow = {} as Window;
  const valid = {
    origin: "https://example.test",
    source: expectedWindow,
    data: { type: "file-preview-ready" },
  } as MessageEvent;
  assert.equal(isPreviewFrameMessage(valid, expectedWindow, valid.origin), true);
  assert.equal(isPreviewFrameMessage({ ...valid, origin: "https://evil.test" }, expectedWindow, valid.origin), false);
  assert.equal(isPreviewFrameMessage({ ...valid, source: {} as Window }, expectedWindow, valid.origin), false);
  assert.equal(isPreviewFrameMessage({ ...valid, data: { type: "other" } }, expectedWindow, valid.origin), false);
});

test("consumePreviewContextFromHash returns id and clears the fragment", () => {
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hash: "#context=opaque-id", pathname: "/file-preview.html", search: "" },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { state: { x: 1 } },
  });
  try {
    const calls: unknown[][] = [];
    assert.equal(
      consumePreviewContextFromHash(undefined, (...args) => calls.push(args)),
      "opaque-id",
    );
    assert.deepEqual(calls, [[{ x: 1 }, "", "/file-preview.html"]]);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: previousLocation });
    Object.defineProperty(globalThis, "history", { configurable: true, value: previousHistory });
  }
});

test("frame loader uses only the fixed Preview-authenticated content URL", async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    requests.push({
      url: String(input),
      method,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/markdown",
          "content-disposition": "inline; filename*=UTF-8''README.md",
          "x-preview-theme": "dark",
          "x-preview-locale": "zh-CN",
        },
      });
    }
    return new Response(new Blob(["hello"], { type: "text/markdown" }), { status: 200 });
  };

  const result = await loadFramePreviewFile({ contextId: "opaque-id", fetchImpl });
  assert.equal(result.file.name, "README.md");
  assert.equal(await result.file.text(), "hello");
  assert.equal(result.theme, "dark");
  assert.equal(result.locale, "zh-CN");
  assert.deepEqual(requests, [
    { url: "/api/files/preview-content", method: "HEAD", authorization: "Preview opaque-id" },
    { url: "/api/files/preview-content", method: "GET", authorization: "Preview opaque-id" },
  ]);
});
