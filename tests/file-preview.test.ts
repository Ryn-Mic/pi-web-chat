import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activatePreview,
  clearPreviewWorkspace,
  closePreview,
  createPreviewWorkspaceState,
  getPreviewWorkspaceState,
  mergePreviewWorkspace,
  openPreview,
  previewIdentity,
  reducePreviewWorkspace,
  showFilesTab,
} from "../src/lib/file-preview.ts";

function stateAfter(
  initial = createPreviewWorkspaceState(),
  ...actions: { type: "open"; tab: { cwd: string; path: string; name: string; lastActiveAt: number } }[]
) {
  return actions.reduce((s, a) => reducePreviewWorkspace(s, a), initial);
}

test("previewIdentity is collision-free across cwd/path boundaries", () => {
  const a = previewIdentity("/project", "sub/file.txt");
  const b = previewIdentity("/project/sub", "file.txt");
  assert.notEqual(a, b);
  assert.equal(a, JSON.stringify(["/project", "sub/file.txt"]));
});

test("openPreview deduplicates by cwd/path and evicts the least recently active ninth tab", () => {
  let state = createPreviewWorkspaceState();
  for (let i = 0; i < 8; i++) {
    state = reducePreviewWorkspace(state, {
      type: "open",
      tab: { cwd: "/p", path: `f${i}.txt`, name: `f${i}.txt`, lastActiveAt: i },
    });
  }
  state = reducePreviewWorkspace(state, {
    type: "open",
    tab: { cwd: "/p", path: "f8.txt", name: "f8.txt", lastActiveAt: 8 },
  });
  assert.deepEqual(
    state.tabs.map((tab) => tab.path),
    ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "f7.txt", "f8.txt"],
  );
  assert.equal(state.active, previewIdentity("/p", "f8.txt"));
});

test("re-opening an existing preview updates its timestamp and activates it", () => {
  let state = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "a.txt", name: "a.txt", lastActiveAt: 1 } },
    { type: "open", tab: { cwd: "/p", path: "b.txt", name: "b.txt", lastActiveAt: 2 } },
    { type: "open", tab: { cwd: "/p", path: "a.txt", name: "a.txt", lastActiveAt: 3 } },
  );
  assert.deepEqual(state.tabs.map((tab) => tab.path), ["a.txt", "b.txt"]);
  assert.equal(state.active, previewIdentity("/p", "a.txt"));
  assert.equal(state.tabs[0]?.lastActiveAt, 3);
});

test("LRU eviction breaks ties by choosing the leftmost tab", () => {
  let state = createPreviewWorkspaceState();
  for (let i = 0; i < 8; i++) {
    state = reducePreviewWorkspace(state, {
      type: "open",
      tab: { cwd: "/p", path: `f${i}.txt`, name: `f${i}.txt`, lastActiveAt: 0 },
    });
  }
  state = reducePreviewWorkspace(state, {
    type: "open",
    tab: { cwd: "/p", path: "f8.txt", name: "f8.txt", lastActiveAt: 1 },
  });
  assert.deepEqual(
    state.tabs.map((tab) => tab.path),
    ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "f7.txt", "f8.txt"],
  );
});

test("closing the active preview selects the left neighbor", () => {
  let state = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "a.txt", name: "a.txt", lastActiveAt: 1 } },
    { type: "open", tab: { cwd: "/p", path: "b.txt", name: "b.txt", lastActiveAt: 2 } },
    { type: "open", tab: { cwd: "/p", path: "c.txt", name: "c.txt", lastActiveAt: 3 } },
  );
  state = reducePreviewWorkspace(state, {
    type: "close",
    identity: previewIdentity("/p", "c.txt"),
  });
  assert.equal(state.active, previewIdentity("/p", "b.txt"));
  assert.deepEqual(state.tabs.map((tab) => tab.path), ["a.txt", "b.txt"]);

  state = reducePreviewWorkspace(state, {
    type: "close",
    identity: previewIdentity("/p", "b.txt"),
  });
  assert.equal(state.active, previewIdentity("/p", "a.txt"));
});

test("closing the leftmost active preview selects the new first tab", () => {
  let state = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "a.txt", name: "a.txt", lastActiveAt: 1 } },
    { type: "open", tab: { cwd: "/p", path: "b.txt", name: "b.txt", lastActiveAt: 2 } },
  );
  state = reducePreviewWorkspace(state, {
    type: "close",
    identity: previewIdentity("/p", "a.txt"),
  });
  assert.equal(state.active, previewIdentity("/p", "b.txt"));
});

test("closing the last preview falls back to the Files tab", () => {
  let state = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "a.txt", name: "a.txt", lastActiveAt: 1 } },
  );
  state = reducePreviewWorkspace(state, {
    type: "close",
    identity: previewIdentity("/p", "a.txt"),
  });
  assert.equal(state.active, "files");
  assert.deepEqual(state.tabs, []);
});

test("the Files tab cannot be closed", () => {
  let state = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "a.txt", name: "a.txt", lastActiveAt: 1 } },
  );
  const before = state;
  state = reducePreviewWorkspace(state, { type: "close", identity: "files" });
  assert.deepEqual(state, before);
});

test("different chat tabs keep isolated preview workspaces", () => {
  openPreview("chat-a", "/p", "a.txt", "a.txt", 1);
  openPreview("chat-b", "/p", "b.txt", "b.txt", 2);

  const a = getPreviewWorkspaceState("chat-a");
  const b = getPreviewWorkspaceState("chat-b");

  assert.deepEqual(a.tabs.map((tab) => tab.path), ["a.txt"]);
  assert.deepEqual(b.tabs.map((tab) => tab.path), ["b.txt"]);
  assert.equal(a.active, previewIdentity("/p", "a.txt"));
  assert.equal(b.active, previewIdentity("/p", "b.txt"));
});

test("clearPreviewWorkspace empties one tab without touching others", () => {
  openPreview("chat-clear", "/p", "a.txt", "a.txt", 1);
  openPreview("chat-other", "/p", "b.txt", "b.txt", 2);

  clearPreviewWorkspace("chat-clear");

  assert.deepEqual(getPreviewWorkspaceState("chat-clear").tabs, []);
  assert.equal(getPreviewWorkspaceState("chat-clear").active, "files");
  assert.deepEqual(getPreviewWorkspaceState("chat-other").tabs.map((tab) => tab.path), ["b.txt"]);
});

test("merge deduplicates by identity and keeps the newer timestamp", () => {
  const surviving = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "shared.txt", name: "shared.txt", lastActiveAt: 10 } },
    { type: "open", tab: { cwd: "/p", path: "s-only.txt", name: "s-only.txt", lastActiveAt: 20 } },
  );
  const losing = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "shared.txt", name: "shared.txt", lastActiveAt: 5 } },
    { type: "open", tab: { cwd: "/p", path: "l-only.txt", name: "l-only.txt", lastActiveAt: 30 } },
  );

  const merged = reducePreviewWorkspace(surviving, { type: "merge", source: losing });

  assert.deepEqual(
    merged.tabs.map((tab) => ({ path: tab.path, lastActiveAt: tab.lastActiveAt })),
    [
      { path: "shared.txt", lastActiveAt: 10 },
      { path: "s-only.txt", lastActiveAt: 20 },
      { path: "l-only.txt", lastActiveAt: 30 },
    ],
  );
});

test("merge prefers the losing active identity when it is retained", () => {
  const surviving = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "s.txt", name: "s.txt", lastActiveAt: 10 } },
  );
  const losing = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "l.txt", name: "l.txt", lastActiveAt: 20 } },
  );

  const merged = reducePreviewWorkspace(surviving, { type: "merge", source: losing });

  assert.equal(merged.active, previewIdentity("/p", "l.txt"));
});

test("merge falls back to the surviving active identity when the losing active is the Files tab", () => {
  const surviving = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "s.txt", name: "s.txt", lastActiveAt: 10 } },
  );
  const losing = createPreviewWorkspaceState();

  const merged = reducePreviewWorkspace(surviving, { type: "merge", source: losing });

  assert.equal(merged.active, previewIdentity("/p", "s.txt"));
});

test("merge applies the same 8-tab LRU cap and protects the chosen active", () => {
  const surviving = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "s1.txt", name: "s1.txt", lastActiveAt: 10 } },
    { type: "open", tab: { cwd: "/p", path: "s2.txt", name: "s2.txt", lastActiveAt: 20 } },
    { type: "open", tab: { cwd: "/p", path: "s3.txt", name: "s3.txt", lastActiveAt: 30 } },
    { type: "open", tab: { cwd: "/p", path: "s4.txt", name: "s4.txt", lastActiveAt: 40 } },
  );
  const losing = stateAfter(
    createPreviewWorkspaceState(),
    { type: "open", tab: { cwd: "/p", path: "l1.txt", name: "l1.txt", lastActiveAt: 5 } },
    { type: "open", tab: { cwd: "/p", path: "l2.txt", name: "l2.txt", lastActiveAt: 15 } },
    { type: "open", tab: { cwd: "/p", path: "l3.txt", name: "l3.txt", lastActiveAt: 25 } },
    { type: "open", tab: { cwd: "/p", path: "l4.txt", name: "l4.txt", lastActiveAt: 35 } },
    { type: "open", tab: { cwd: "/p", path: "l5.txt", name: "l5.txt", lastActiveAt: 45 } },
  );

  const merged = reducePreviewWorkspace(surviving, { type: "merge", source: losing });

  assert.equal(merged.tabs.length, 8);
  assert.equal(merged.active, previewIdentity("/p", "l5.txt"));
  // The least-recently-active non-protected tab (l1, timestamp 5) should have been evicted.
  assert.equal(
    merged.tabs.some((tab) => tab.path === "l1.txt"),
    false,
  );
});

test("mergePreviewWorkspace moves state from losing to surviving and removes losing", () => {
  const losingKey = `merge-loser-${Date.now()}`;
  const survivingKey = `merge-winner-${Date.now()}`;

  openPreview(losingKey, "/p", "l.txt", "l.txt", 10);
  openPreview(survivingKey, "/p", "s.txt", "s.txt", 20);

  mergePreviewWorkspace(losingKey, survivingKey);

  assert.deepEqual(
    getPreviewWorkspaceState(survivingKey).tabs.map((tab) => tab.path),
    ["s.txt", "l.txt"],
  );
  assert.equal(getPreviewWorkspaceState(losingKey).tabs.length, 0);
  assert.equal(getPreviewWorkspaceState(losingKey).active, "files");
});
