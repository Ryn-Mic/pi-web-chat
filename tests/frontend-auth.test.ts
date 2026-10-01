import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticatedFetch, checkAuth, getAuthStatus, getSessionToken, login, logout, setAuthStatus, setSessionToken } from "../src/lib/auth.ts";

function fixture() {
  const original = { fetch: globalThis.fetch, status: getAuthStatus(), token: getSessionToken() };
  let finish!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  setSessionToken("fixture-a"); setAuthStatus("authenticated");
  return { reply: (status: number, body = "") => finish(new Response(body, { status })), restore() {
    globalThis.fetch = original.fetch; setSessionToken(original.token); setAuthStatus(original.status);
  } };
}

test("late status responses cannot resurrect logout or invalidate a newer login", async () => {
  const f = fixture();
  try {
    const old = checkAuth(); setSessionToken(null); setAuthStatus("unauthenticated"); f.reply(200); await old;
    assert.equal(getAuthStatus(), "unauthenticated");
    setSessionToken("fixture-a"); setAuthStatus("authenticated");
    const stale = checkAuth(); setSessionToken("fixture-b"); f.reply(401); await stale;
    assert.equal(getAuthStatus(), "authenticated");
  } finally { f.restore(); }
});

test("temporary HTTP errors preserve authenticated state", async () => {
  const f = fixture();
  try { for (const status of [500, 502, 503]) {
    const pending = checkAuth(); f.reply(status);
    assert.equal(await pending, "checking"); assert.equal(getAuthStatus(), "authenticated");
  } } finally { f.restore(); }
});

test("authenticated transport ignores a late 401 owned by an old credential", async () => {
  const f = fixture();
  try {
    const pending = authenticatedFetch("/api/models"); const rejected = assert.rejects(pending, { name: "AbortError" });
    setSessionToken("fixture-b"); f.reply(401); await rejected;
    assert.equal(getAuthStatus(), "authenticated");
  } finally { f.restore(); }
});

test("logout invalidates locally before network completion and cannot erase a later login", async () => {
  const f = fixture();
  try {
    const pending = logout(); assert.equal(getSessionToken(), null); assert.equal(getAuthStatus(), "unauthenticated");
    setSessionToken("fixture-b"); setAuthStatus("authenticated"); f.reply(200); await pending;
    assert.equal(getAuthStatus(), "authenticated"); assert.equal(getSessionToken(), "fixture-b");
  } finally { f.restore(); }
});

test("a cancelled login response cannot restore credentials after logout", async () => {
  const f = fixture();
  try {
    setSessionToken(null); setAuthStatus("unauthenticated");
    const pending = login("fixture-access"); await logout(); f.reply(200, JSON.stringify({ sessionToken: "fixture-new" }));
    assert.equal((await pending).ok, false); assert.equal(getSessionToken(), null);
  } finally { f.restore(); }
});
