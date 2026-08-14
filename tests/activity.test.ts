import assert from "node:assert/strict";
import { test } from "node:test";
import { activityDotClass, connectionActivity } from "../src/lib/activity.ts";

test("connected sessions have distinct running and idle activity states", () => {
  assert.equal(connectionActivity("connected", true), "running");
  assert.equal(connectionActivity("connected", false), "idle");
  assert.equal(connectionActivity("connecting", false), "waiting");
  assert.equal(connectionActivity("disconnected", false), "error");
});

test("idle dots use a neutral color while running dots can pulse", () => {
  assert.match(activityDotClass("idle"), /zinc/);
  assert.doesNotMatch(activityDotClass("idle"), /emerald|amber|red/);
  assert.match(activityDotClass("running"), /emerald.*animate-pulse/);
  assert.doesNotMatch(activityDotClass("running", false), /animate-pulse/);
});
