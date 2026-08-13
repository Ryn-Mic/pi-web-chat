import assert from "node:assert/strict";
import { File } from "node:buffer";
import { test } from "node:test";
import { createFileViewerNotificationGate } from "../src/lib/file-viewer-notifications.ts";

test("consecutive ready states for the same file only notify once", () => {
  const file = new File([], "a.txt");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(file, { ready: true, error: null }), { type: "ready" });
  assert.equal(gate(file, { ready: true, error: null }), null);
  assert.equal(gate(file, { ready: true, error: null }), null);
});

test("ready false then ready true can notify again", () => {
  const file = new File([], "a.txt");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(file, { ready: true, error: null }), { type: "ready" });
  assert.equal(gate(file, { ready: false, error: null }), null);
  assert.deepEqual(gate(file, { ready: true, error: null }), { type: "ready" });
});

test("the same error object for the same file only notifies once", () => {
  const file = new File([], "a.txt");
  const error = new Error("boom");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(file, { ready: false, error }), { type: "error", error });
  assert.equal(gate(file, { ready: false, error }), null);
  assert.equal(gate(file, { ready: false, error }), null);
});

test("after an error, a ready state can notify again", () => {
  const file = new File([], "a.txt");
  const error = new Error("boom");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(file, { ready: false, error }), { type: "error", error });
  assert.deepEqual(gate(file, { ready: true, error: null }), { type: "ready" });
});

test("a ready state between errors lets the same error object notify again", () => {
  const file = new File([], "a.txt");
  const error = new Error("boom");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(file, { ready: false, error }), { type: "error", error });
  assert.deepEqual(gate(file, { ready: true, error: null }), { type: "ready" });
  assert.deepEqual(gate(file, { ready: false, error }), { type: "error", error });
  assert.equal(gate(file, { ready: false, error }), null);
});

test("changing the file identity resets the ready gate", () => {
  const fileA = new File([], "a.txt");
  const fileB = new File([], "b.txt");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(fileA, { ready: true, error: null }), { type: "ready" });
  assert.equal(gate(fileA, { ready: true, error: null }), null);
  assert.deepEqual(gate(fileB, { ready: true, error: null }), { type: "ready" });
  assert.equal(gate(fileB, { ready: true, error: null }), null);
  assert.deepEqual(gate(fileA, { ready: true, error: null }), { type: "ready" });
});

test("changing the file identity resets the error gate", () => {
  const fileA = new File([], "a.txt");
  const fileB = new File([], "b.txt");
  const error = new Error("boom");
  const gate = createFileViewerNotificationGate();

  assert.deepEqual(gate(fileA, { ready: false, error }), { type: "error", error });
  assert.equal(gate(fileA, { ready: false, error }), null);
  assert.deepEqual(gate(fileB, { ready: false, error }), { type: "error", error });
  assert.equal(gate(fileB, { ready: false, error }), null);
  assert.deepEqual(gate(fileA, { ready: false, error }), { type: "error", error });
});
