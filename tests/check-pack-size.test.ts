import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPackSizeWithinLimits,
  assertRequiredPackFiles,
  MAX_PACKED_BYTES,
  MAX_UNPACKED_BYTES,
  REQUIRED_RUNTIME_FILES,
} from "../scripts/check-pack-size.mjs";

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
