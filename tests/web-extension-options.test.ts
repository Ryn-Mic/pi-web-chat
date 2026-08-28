import assert from "node:assert/strict";
import { test } from "node:test";
import { managedRestartPortError, parseWebOptions } from "../extensions/pi-web-chat.ts";

test("web restart accepts an explicit recovery port", () => {
  assert.deepEqual(parseWebOptions(["restart", "3141"], { port: "3141", host: "127.0.0.1" }), {
    action: "restart",
    port: "3141",
    host: "127.0.0.1",
    portExplicit: true,
    hostExplicit: false,
    token: undefined,
  });
  assert.equal(managedRestartPortError("restart", true), undefined);
});

test("managed web restart rejects an implicit daemon-state port", () => {
  assert.equal(
    managedRestartPortError("restart", false),
    "managed restart requires an explicit port; use pi --web 3141 restart",
  );
});

test("web host and lan options are parsed independently from the access token", () => {
  const defaults = { port: "3141", host: "127.0.0.1" };
  assert.deepEqual(parseWebOptions(["--lan"], defaults), {
    action: "start",
    port: "3141",
    host: "0.0.0.0",
    portExplicit: false,
    hostExplicit: true,
    token: undefined,
  });
  assert.deepEqual(parseWebOptions(["--host", "127.0.0.2", "--token=secret"], defaults), {
    action: "start",
    port: "3141",
    host: "127.0.0.2",
    portExplicit: false,
    hostExplicit: true,
    token: "secret",
  });
});
