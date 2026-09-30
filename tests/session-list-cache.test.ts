import assert from "node:assert/strict";
import { test } from "node:test";
import type { UISessionInfo } from "../shared/protocol.ts";
import { clearSessionListCache, readSessionListCache, writeSessionListCache } from "../src/lib/session-list-cache.ts";
import { getSessionCacheScope, setAuthStatus, setSessionToken } from "../src/lib/auth.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const summary = (id: number): UISessionInfo => ({
  id: `session-${id}`, path: `/sessions/${id}.jsonl`, project: "/project", name: "A".repeat(400),
  firstMessage: "B".repeat(400), modified: "2026-09-30T00:00:00Z", messageCount: 1, isStreaming: true,
});

test("cache keeps only a bounded first page, expires and isolates authenticated scopes", () => {
  const storage = new MemoryStorage();
  writeSessionListCache("login-a", Array.from({ length: 90 }, (_, index) => summary(index)), 1000, storage);
  const rows = readSessionListCache("login-a", 2000, storage)!;
  assert.equal(rows.length, 40);
  assert.equal(rows[0]?.firstMessage.length, 200);
  assert.equal(rows[0]?.name?.length, 200);
  assert.equal(rows[0]?.isStreaming, undefined, "cached rows cannot claim a current running status");
  assert.equal(readSessionListCache("login-b", 2000, storage), undefined);
  assert.equal(readSessionListCache("login-a", 1000 + 24 * 60 * 60_000 + 1, storage), undefined);
});

test("cache corruption or inaccessible storage cannot prevent opening the app", () => {
  const storage = new MemoryStorage();
  storage.setItem("pi-web-chat:session-list:scope", "not json");
  assert.equal(readSessionListCache("scope", 1000, storage), undefined);
  storage.setItem("pi-web-chat:session-list:scope", JSON.stringify({ at: 1000, sessions: [{ id: "bad" }] }));
  assert.equal(readSessionListCache("scope", 1000, storage), undefined);
  const blocked = { length: 1, key() { throw new Error("blocked"); }, getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readSessionListCache("scope", 1000, blocked), undefined);
  assert.doesNotThrow(() => writeSessionListCache("scope", [summary(0)], 1000, blocked));
  assert.doesNotThrow(() => clearSessionListCache(blocked));
});

test("login replacement, authorization failure and logout clear persistent summaries without credentials in scope", () => {
  const storage = new MemoryStorage();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    setSessionToken("credential-a");
    setAuthStatus("authenticated");
    const firstScope = getSessionCacheScope();
    writeSessionListCache(firstScope, [summary(0)]);
    assert.ok(firstScope && !firstScope.includes("credential"));
    assert.equal(getSessionCacheScope(), firstScope, "reloads within the same login retain the cache namespace");
    setSessionToken("credential-b");
    const secondScope = getSessionCacheScope();
    assert.notEqual(secondScope, firstScope);
    assert.equal(readSessionListCache(firstScope), undefined);
    writeSessionListCache(secondScope, [summary(1)]);
    setAuthStatus("unauthenticated");
    assert.equal(readSessionListCache(secondScope), undefined);
    setAuthStatus("authenticated");
    writeSessionListCache(secondScope, [summary(2)]);
    setSessionToken(null);
    assert.equal(readSessionListCache(secondScope), undefined);
    assert.equal(getSessionCacheScope(), "");
  } finally {
    setSessionToken(null);
    setAuthStatus("unauthenticated");
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
