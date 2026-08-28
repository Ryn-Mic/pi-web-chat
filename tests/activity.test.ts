import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityEyeState,
  activityEyeTone,
  connectionActivity,
} from "../src/lib/activity.ts";

test("connected sessions have distinct running and idle activity states", () => {
  assert.equal(connectionActivity("connected", true), "running");
  assert.equal(connectionActivity("connected", false), "idle");
  assert.equal(connectionActivity("connecting", false), "waiting");
  assert.equal(connectionActivity("disconnected", false), "error");
});

test("activity states map to distinct GrokBot eye expressions", () => {
  assert.equal(activityEyeState("running"), "working");
  assert.equal(activityEyeState("waiting"), "thinking");
  assert.equal(activityEyeState("error"), "error");
  assert.equal(activityEyeState("idle"), "idle");
});

test("eye tones use the old breathing-dot colors with refreshed idle standby", () => {
  assert.match(activityEyeTone("idle"), /sky/);
  assert.doesNotMatch(activityEyeTone("idle"), /emerald|amber|red/);
  assert.match(activityEyeTone("running"), /emerald/);
  assert.match(activityEyeTone("waiting"), /amber/);
  assert.match(activityEyeTone("error"), /red/);
});
