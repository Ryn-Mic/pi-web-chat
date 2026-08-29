import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FILE_VIEWER_ASSET_ROOT,
  FileViewerAssetPathEscapeError,
  resolveFileViewerAssetPath,
  resolveFileViewerAssetRoot,
} from "../server/file-viewer-assets.ts";

test("File Viewer asset root resolves through the package export", () => {
  assert.equal(resolveFileViewerAssetRoot(), FILE_VIEWER_ASSET_ROOT);
  assert.equal(existsSync(join(FILE_VIEWER_ASSET_ROOT, "flyfish-viewer-assets.json")), true);
  assert.equal(
    existsSync(join(FILE_VIEWER_ASSET_ROOT, "vendor", "pdf", "pdf.worker.mjs")),
    true,
  );
});

test("File Viewer asset paths stay inside the dependency asset root", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-web-viewer-assets-"));
  const root = join(sandbox, "viewer");
  const outside = join(sandbox, "outside");
  mkdirSync(join(root, "vendor", "pdf"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "escape"), "dir");
  try {
    assert.equal(
      resolveFileViewerAssetPath("/file-viewer/vendor/pdf/pdf.worker.mjs", root),
      join(realpathSync(root), "vendor", "pdf", "pdf.worker.mjs"),
    );
    assert.equal(resolveFileViewerAssetPath("/file-viewer/%", root), join(realpathSync(root), "%"));
    assert.equal(resolveFileViewerAssetPath("/assets/app.js", root), null);
    assert.throws(
      () => resolveFileViewerAssetPath("/file-viewer/../package.json", root),
      FileViewerAssetPathEscapeError,
    );
    assert.throws(
      () => resolveFileViewerAssetPath("/file-viewer//etc/passwd", root),
      FileViewerAssetPathEscapeError,
    );
    assert.throws(
      () => resolveFileViewerAssetPath("/file-viewer/escape", root),
      FileViewerAssetPathEscapeError,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
