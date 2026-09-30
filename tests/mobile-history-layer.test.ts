import assert from "node:assert/strict";
import { test } from "node:test";
import { createMobileHistoryLayer } from "../src/lib/mobile-history-layer.ts";

function fixture() {
  const entries = [{ router: "original" } as Record<string, unknown>];
  const listeners = new Set<() => void>();
  let href = "https://example.test/s/session-a";
  let index = 0;
  let backs = 0;
  const host = {
    history: {
      get state() { return entries[index]; },
      pushState(state: Record<string, unknown>) { entries.splice(++index); entries.push(state); },
      replaceState(state: Record<string, unknown>) { entries[index] = state; },
      back() { backs += 1; index = Math.max(0, index - 1); for (const listener of listeners) listener(); },
    },
    href: () => href,
    onPop(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { host, entries, get backs() { return backs; }, setHref(value: string) { href = value; } };
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 5));

test("cancelled browser Back recreates one overlay entry and remains closeable", async () => {
  const state = fixture();
  let allowClose = false;
  let closes = 0;
  const layer = createMobileHistoryLayer(() => { closes += 1; }, state.host, () => allowClose);
  const unmount = layer.mount();
  const marker = state.host.history.state.mobilePreviewLayer;
  state.host.history.back();
  state.host.history.back();
  assert.equal(closes, 0);
  assert.equal(state.entries.length, 2);
  assert.equal(state.host.history.state.mobilePreviewLayer, marker);
  assert.equal(layer.close(), false);
  allowClose = true;
  assert.equal(layer.close(), true);
  assert.equal(closes, 1);
  unmount();
  await nextTask();
  assert.equal(state.backs, 3);
});

test("StrictMode effect replay creates one entry and cancels premature cleanup", async () => {
  const state = fixture();
  let closes = 0;
  const layer = createMobileHistoryLayer(() => { closes += 1; }, state.host);
  layer.mount()();
  const unmount = layer.mount();
  await nextTask();
  assert.equal(state.entries.length, 2);
  assert.equal(state.backs, 0);
  layer.close();
  layer.close();
  assert.equal(state.backs, 1);
  assert.equal(closes, 1);
  unmount();
  await nextTask();
  assert.equal(state.backs, 1, "unmount after a close must not navigate twice");
});

test("parent unmount releases its duplicate entry without calling the removed overlay", async () => {
  const state = fixture();
  let closes = 0;
  const layer = createMobileHistoryLayer(() => { closes += 1; }, state.host);
  layer.mount()();
  await nextTask();
  assert.equal(state.backs, 1);
  assert.deepEqual(state.host.history.state, { router: "original" });
  assert.equal(closes, 0);
});

test("cleanup preserves a replacement session route and removes only its marker", async () => {
  const state = fixture();
  const layer = createMobileHistoryLayer(() => {}, state.host);
  const unmount = layer.mount();
  state.setHref("https://example.test/s/session-b");
  state.host.history.replaceState({ ...state.host.history.state, router: "session-b" });
  unmount();
  await nextTask();
  assert.equal(state.backs, 0);
  assert.deepEqual(state.host.history.state, { router: "session-b" });
});

test("cleanup never changes an entry owned by a newer overlay", async () => {
  const state = fixture();
  const first = createMobileHistoryLayer(() => {}, state.host);
  const unmountFirst = first.mount();
  const second = createMobileHistoryLayer(() => {}, state.host);
  const unmountSecond = second.mount();
  const newest = state.host.history.state;
  unmountFirst();
  await nextTask();
  assert.equal(state.host.history.state, newest);
  assert.equal(state.backs, 0);
  second.close();
  unmountSecond();
});
