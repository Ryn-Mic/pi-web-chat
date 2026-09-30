import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTextBytes, MAX_TEXT_BYTES } from "../shared/text-file.ts";
import { fallbackTextPreview } from "../src/lib/file-preview-text.ts";

test("UTF-8 source detection preserves BOM, whitespace and empty files", () => {
  for (const text of ["", "\uFEFFhello\r\n\t中文", "FROM node:22\n", "*.log\n"]) {
    assert.equal(decodeTextBytes(new TextEncoder().encode(text)), text);
  }
});

test("source detection rejects invalid encodings, binary controls, documents and oversized files", () => {
  for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0]), new Uint8Array([7]), new TextEncoder().encode("%PDF-1.7\n"), new Uint8Array([0x50, 0x4b, 3, 4]), new Uint8Array(MAX_TEXT_BYTES + 1)]) {
    assert.equal(decodeTextBytes(bytes), null);
  }
});

test("unknown text filenames fall back to safe source while binary remains unsupported", async () => {
  const source = "<script>parent.__previewPwned = true</script>";
  const fallback = await fallbackTextPreview(new File([source], "Dockerfile"));
  assert.equal(fallback?.name, "Dockerfile.txt");
  assert.equal(fallback?.type, "text/plain");
  assert.equal(await fallback?.text(), source);
  assert.equal(await fallbackTextPreview(new File([new Uint8Array([0, 1, 2])], "unknown.bin")), null);
});
