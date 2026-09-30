import assert from "node:assert/strict";
import { test } from "node:test";
import type { UISessionInfo } from "../shared/protocol.ts";
import { SessionCatalog, SessionCatalogCursorError } from "../server/session-catalog.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}

const summary = (id: string, modified = "2026-09-30T00:00:00Z"): UISessionInfo => ({
  id, path: `/sessions/${id}.jsonl`, project: "/project", firstMessage: `Message ${id}`, modified, messageCount: 1,
});

test("cold catalog response does not wait for either source and publishes independently", async () => {
  const pi = deferred<UISessionInfo[]>();
  const codex = deferred<UISessionInfo[]>();
  let publishPi!: (rows: UISessionInfo[]) => void;
  let calls = 0;
  const catalog = new SessionCatalog({
    pi: (publish) => { calls += 1; publishPi = publish; return pi.promise; },
    codex: () => codex.promise,
  });
  assert.deepEqual(catalog.page(), { sessions: [], nextCursor: null, scanning: true });
  assert.equal(calls, 1);
  catalog.page();
  assert.equal(calls, 1, "concurrent readers share one background scan");
  publishPi([summary("pi-first")]);
  assert.equal(catalog.page().sessions[0]?.id, "pi-first");
  pi.resolve([summary("pi-first"), summary("pi-second")]);
  await pi.promise;
  assert.equal(catalog.page().scanning, true, "Codex can finish after Pi rows become usable");
  codex.resolve([summary("codex:native")]);
  await catalog.refresh();
  assert.equal(catalog.page().scanning, false);
  assert.equal(catalog.page().sessions.length, 3);
});

test("page cursors preserve ordering across creation, rename and deletion", async () => {
  let rows = Array.from({ length: 90 }, (_, index) => summary(`id-${index.toString().padStart(2, "0")}`));
  const catalog = new SessionCatalog({ pi: async () => rows });
  await catalog.refresh();
  const first = catalog.page();
  assert.equal(first.sessions.length, 40);
  const expected = rows.map((row) => row.id);
  rows[40]!.name = "Changed after snapshot";
  rows = [summary("newest", "2026-10-01T00:00:00Z"), ...rows.slice(1)];
  catalog.invalidate();
  await catalog.refresh();
  const second = catalog.page({ cursor: first.nextCursor });
  const third = catalog.page({ cursor: second.nextCursor });
  assert.deepEqual([...first.sessions, ...second.sessions, ...third.sessions].map((row) => row.id), expected);
  assert.equal(second.sessions[0]?.name, undefined, "snapshots copy summary values rather than mutable loader objects");
  assert.equal(catalog.page().sessions[0]?.id, "newest");
});

test("search spans catalog rows beyond the first page and stale cursors reject explicitly", async () => {
  let now = 100_000;
  const catalog = new SessionCatalog({ pi: async () => Array.from({ length: 80 }, (_, index) => summary(`id-${index}`)) }, {
    now: () => now, snapshotTtlMs: 1000,
  });
  await catalog.refresh();
  assert.deepEqual(catalog.page({ query: "Message id-79" }).sessions.map((row) => row.id), ["id-79"]);
  const first = catalog.page();
  now += 1001;
  assert.throws(() => catalog.page({ cursor: first.nextCursor }), SessionCatalogCursorError);
  assert.throws(() => catalog.page({ cursor: "catalog:invalid:40" }), SessionCatalogCursorError);
  assert.throws(() => catalog.page({ limit: 101 }), SessionCatalogCursorError);
});

test("failed sources retain usable rows, stop scanning and retry with backoff or explicit refresh", async () => {
  let fail = false;
  let calls = 0;
  let now = 1000;
  const catalog = new SessionCatalog({
    pi: async () => [summary("pi")],
    codex: async () => { calls += 1; if (fail) throw new Error("backend unavailable"); return [summary("codex:one")]; },
  }, { now: () => now });
  await catalog.refresh();
  fail = true;
  await catalog.refresh();
  const failed = catalog.page();
  assert.equal(failed.partialFailure, true);
  assert.equal(failed.scanning, false);
  assert.equal(failed.sessions.length, 2);
  now += 700;
  catalog.page();
  assert.equal(calls, 2, "short polling must not loop forever on a missing backend");
  const retry = catalog.page({ refresh: true });
  assert.equal(retry.scanning, true);
  await catalog.refresh();
  assert.equal(calls, 3);
  assert.equal(catalog.page().partialFailure, true);
});

test("warm batches preserve old rows until a source completes authoritative reconciliation", async () => {
  const next = deferred<UISessionInfo[]>();
  let step = 0;
  let publish!: (rows: UISessionInfo[]) => void;
  const catalog = new SessionCatalog({ pi: async (callback) => {
    if (step++ === 0) return [summary("old-a"), summary("old-b")];
    publish = callback;
    return next.promise;
  } });
  await catalog.refresh();
  const task = catalog.refresh();
  publish([{ ...summary("old-a"), name: "Renamed" }]);
  assert.equal(catalog.page().sessions.length, 2);
  next.resolve([{ ...summary("old-a"), name: "Renamed" }]);
  await task;
  assert.deepEqual(catalog.page().sessions.map((row) => row.id), ["old-a"]);
});
