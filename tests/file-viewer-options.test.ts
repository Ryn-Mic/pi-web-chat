import assert from "node:assert/strict";
import { test } from "node:test";
import { createFileViewerOptions } from "../src/lib/file-viewer-options.ts";

test("desktop options keep comfortable default and disable exfiltration operations", () => {
  const options = createFileViewerOptions({ mobile: false, theme: "dark", locale: "ko" });
  assert.equal(options.theme, "dark");
  assert.equal(options.locale, "en-US");
  assert.equal(options.ui, undefined);
  assert.deepEqual(options.toolbar, {
    position: "bottom-right",
    download: false,
    print: false,
    exportHtml: false,
    zoom: true,
    permissions: {
      download: false,
      print: false,
      "export-html": false,
    },
  });
  assert.deepEqual(options.archive, { entryActions: { download: false } });
  assert.equal("fit" in options, false);
});

test("mobile options use compact density and map supported locales", () => {
  assert.deepEqual(
    createFileViewerOptions({ mobile: true, theme: "light", locale: "zh" }).ui,
    { density: "compact" },
  );
  assert.equal(
    createFileViewerOptions({ mobile: true, theme: "light", locale: "ja" }).locale,
    "ja-JP",
  );
});
