import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getSessionToken, logout, setSessionToken } from "../src/lib/auth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  setSessionToken(null);
  globalThis.fetch = originalFetch;
});

test("logout sends the old token explicitly before clearing local state", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  setSessionToken("old-session-token");
  await logout();

  assert.ok(captured, "logout should issue a fetch request");
  assert.equal(captured.url, "/api/auth/logout");
  assert.equal(captured.init.method, "POST");
  const headers = (captured.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, "Bearer old-session-token");
  assert.equal(getSessionToken(), null);
});
