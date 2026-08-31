import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPackSizeWithinLimits,
  assertPackExcludesBuildOnlyFiles,
  assertPackExcludesCopiedFileViewerAssets,
  assertRequiredPackFiles,
  MAX_PACKED_BYTES,
  MAX_UNPACKED_BYTES,
  REQUIRED_RUNTIME_FILES,
} from "../scripts/check-pack-size.mjs";

test("pack size budgets stay at the optimized main-package boundary", () => {
  assert.equal(MAX_PACKED_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_UNPACKED_BYTES, 30 * 1024 * 1024);
});

test("pack size accepts exact limits", () => {
  assert.doesNotThrow(() =>
    assertPackSizeWithinLimits({
      size: MAX_PACKED_BYTES,
      unpackedSize: MAX_UNPACKED_BYTES,
    }),
  );
});

test("pack runtime file gate requires the standalone CLI and legacy adapter", () => {
  assert.doesNotThrow(() =>
    assertRequiredPackFiles(REQUIRED_RUNTIME_FILES.map((path) => ({ path }))),
  );
  assert.throws(
    () => assertRequiredPackFiles([{ path: "dist/index.js" }]),
    /dist\/cli\.js/,
  );
});

test("pack file gate rejects copied File Viewer dependency assets", () => {
  assert.doesNotThrow(() =>
    assertPackExcludesCopiedFileViewerAssets([
      { path: "dist/public/assets/file-viewer-react-full.js" },
      { path: "dist/public/file-viewer-old/worker.js" },
      { path: "dist/index.js" },
    ]),
  );
  assert.throws(
    () => assertPackExcludesCopiedFileViewerAssets([{ path: "dist/public/file-viewer" }]),
    /duplicates File Viewer dependency assets/,
  );
  assert.throws(
    () =>
      assertPackExcludesCopiedFileViewerAssets([
        { path: "dist/public/file-viewer/vendor/pdf/pdf.worker.mjs" },
      ]),
    /duplicates File Viewer dependency assets/,
  );
});

test("pack file gate rejects build-only File Viewer inventory", () => {
  assert.doesNotThrow(() =>
    assertPackExcludesBuildOnlyFiles([{ path: "dist/public/.vite/manifest.json" }]),
  );
  assert.throws(
    () =>
      assertPackExcludesBuildOnlyFiles([
        { path: "dist/public/.vite/file-viewer-inventory.json" },
      ]),
    /includes build-only files/,
  );
});

test("pack size rejects either limit plus one byte", () => {
  assert.throws(() =>
    assertPackSizeWithinLimits({
      size: MAX_PACKED_BYTES + 1,
      unpackedSize: MAX_UNPACKED_BYTES,
    }),
  );
  assert.throws(() =>
    assertPackSizeWithinLimits({
      size: MAX_PACKED_BYTES,
      unpackedSize: MAX_UNPACKED_BYTES + 1,
    }),
  );
});
