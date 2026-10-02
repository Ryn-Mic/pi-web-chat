import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cachedDateTimeFormat,
  formatFullDateTime,
  formatRowDateTime,
} from "../src/lib/datetime-format.ts";

test("cachedDateTimeFormat reuses one formatter per locale and option set", () => {
  const options = { month: "short", day: "numeric" } as const;
  const first = cachedDateTimeFormat("en", options);
  assert.equal(cachedDateTimeFormat("en", options), first);
  // A different locale or option set must not share the cached instance.
  assert.notEqual(cachedDateTimeFormat("ja", options), first);
  assert.notEqual(cachedDateTimeFormat("en", { hour: "2-digit" }), first);
  assert.notEqual(cachedDateTimeFormat(undefined, options), first);
  // Output stays correct for the reused instance.
  assert.equal(first.format(new Date(Date.UTC(2026, 9, 2, 12, 0))).includes("Oct"), true);
});

test("row and title formatters render timestamps and pass invalid input through", () => {
  const iso = new Date(Date.UTC(2026, 9, 2, 12, 30)).toISOString();
  const row = formatRowDateTime(iso, "en");
  assert.match(row, /Oct/);
  assert.match(row, /:/);
  assert.equal(formatRowDateTime("not-a-date", "en"), "not-a-date");

  const full = formatFullDateTime(1_759_406_400_000, "en");
  assert.ok(full.length > 0);
  assert.equal(formatFullDateTime("not-a-date", "en"), "not-a-date");
});
