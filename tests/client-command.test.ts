import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientCommand } from "../shared/protocol.ts";
import { boundedPromptRequestId, CLIENT_COMMAND_MAX_BYTES, CLIENT_COMMAND_MAX_TEXT_LENGTH, parseClientCommand, serializeClientCommand } from "../shared/client-command.ts";

test("every ClientCommand variant accepts its normal payload without losing runtime fields", () => {
  const commands = {
    prompt: { type: "prompt", text: "hello", requestId: "prompt-1", images: [{ data: "AA==", mimeType: "image/png" }] },
    get_snapshot: { type: "get_snapshot" },
    sync_events: { type: "sync_events", afterSeq: 0 },
    abort: { type: "abort" },
    set_model: { type: "set_model", provider: "openai", id: "model-1" },
    set_thinking_level: { type: "set_thinking_level", level: "xhigh" },
    fork: { type: "fork", entryId: "entry-1" },
    get_commands: { type: "get_commands" },
    codex_interaction_response: {
      type: "codex_interaction_response",
      response: { id: "request-1", action: "submit", answers: { question: ["answer"] }, content: { custom: [1, null, { enabled: true }] }, scope: "turn" },
    },
    extension_ui_response: { type: "extension_ui_response", response: { id: "extension-1", value: "", confirmed: false, cancelled: false } },
  } satisfies { [T in ClientCommand["type"]]: Extract<ClientCommand, { type: T }> };
  for (const command of Object.values(commands)) assert.equal(parseClientCommand(command), command);
  const permissions = { type: "codex_interaction_response", response: { id: "permissions", action: "accept", scope: "session", content: { fs: { extraRuntimeField: true } }, futureRuntimeField: "retained" } };
  assert.equal(parseClientCommand(permissions), permissions);
});

test("non-object, unknown, and malformed command fields are safely rejected", () => {
  const invalid: unknown[] = [
    null, [], 0, true, "prompt", {}, { type: null }, { type: "unknown" }, { type: "__proto__" },
    { type: "prompt", text: null }, { type: "prompt", text: 1 }, { type: "prompt", text: "hello", requestId: {} },
    { type: "prompt", text: "hello", images: null }, { type: "prompt", text: "hello", images: {} },
    { type: "prompt", text: "hello", images: [null] }, { type: "prompt", text: "hello", images: [{ data: 1, mimeType: "image/png" }] },
    { type: "prompt", text: "hello", images: [{ data: "AA==", mimeType: null }] },
    { type: "prompt", text: "hello", images: [{ data: "AA==", mimeType: "text/plain" }] },
    { type: "sync_events", afterSeq: "1" }, { type: "sync_events", afterSeq: -1 }, { type: "sync_events", afterSeq: 0.5 },
    { type: "sync_events", afterSeq: Infinity }, { type: "sync_events", afterSeq: Number.MAX_SAFE_INTEGER + 1 },
    { type: "set_model", provider: null, id: "model" }, { type: "set_model", provider: "openai", id: [] },
    { type: "set_thinking_level", level: "unknown" }, { type: "fork", entryId: false },
    { type: "codex_interaction_response", response: null }, { type: "codex_interaction_response", response: [] },
    { type: "codex_interaction_response", response: { id: "request", action: "unknown" } },
    { type: "codex_interaction_response", response: { id: "request", action: "submit", answers: null } },
    { type: "codex_interaction_response", response: { id: "request", action: "submit", answers: { question: "text" } } },
    { type: "codex_interaction_response", response: { id: "request", action: "submit", answers: { question: [1] } } },
    { type: "codex_interaction_response", response: { id: "request", action: "accept", scope: "forever" } },
    { type: "extension_ui_response", response: null },
    { type: "extension_ui_response", response: { id: "request", cancelled: "false" } },
    { type: "extension_ui_response", response: { id: "request", confirmed: 1 } },
    { type: "extension_ui_response", response: { id: "request", value: {} } },
  ];
  for (const value of invalid) assert.equal(parseClientCommand(value), null);
});

test("bounded identifiers, text, attachment lists, and answer lists prevent unbounded dispatch", () => {
  assert.equal(parseClientCommand({ type: "prompt", text: "x".repeat(CLIENT_COMMAND_MAX_TEXT_LENGTH + 1) }), null);
  assert.equal(parseClientCommand({ type: "prompt", text: "hello", requestId: "x".repeat(4_097) }), null);
  assert.equal(parseClientCommand({ type: "prompt", text: "hello", images: Array(65).fill({ data: "AA==", mimeType: "image/png" }) }), null);
  assert.equal(parseClientCommand({ type: "codex_interaction_response", response: { id: "request", action: "submit", answers: { question: Array(257).fill("answer") } } }), null);
  assert.equal(parseClientCommand({ type: "extension_ui_response", response: { id: "request", value: "x".repeat(CLIENT_COMMAND_MAX_TEXT_LENGTH + 1) } }), null);
});

test("image-only and empty editor payloads remain valid and all thinking levels are supported", () => {
  assert.ok(parseClientCommand({ type: "prompt", text: "", images: [{ data: "AA==", mimeType: "image/svg+xml" }] }));
  assert.ok(parseClientCommand({ type: "prompt", text: "" }));
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.ok(parseClientCommand({ type: "set_thinking_level", level }));
  }
});

test("rejected prompts retain only an own bounded request id for error correlation", () => {
  const malformed = { type: "prompt", text: null, requestId: "rejected-prompt-1" };
  assert.equal(parseClientCommand(malformed), null);
  assert.equal(boundedPromptRequestId(malformed), "rejected-prompt-1");
  const maximumId = "x".repeat(4_096);
  assert.equal(boundedPromptRequestId({ type: "prompt", text: null, requestId: maximumId }), maximumId);
  for (const value of [null, [], true, "prompt", {}, { type: "abort", requestId: "other" }, { type: "__proto__", requestId: "other" }, { type: "prompt", requestId: null }, { type: "prompt", requestId: 1 }, { type: "prompt", requestId: "x".repeat(4_097) }]) {
    assert.equal(boundedPromptRequestId(value), undefined);
  }
  assert.equal(boundedPromptRequestId(Object.create({ type: "prompt", requestId: "inherited" })), undefined);
  assert.equal(boundedPromptRequestId(Object.assign(Object.create({ requestId: "inherited" }), { type: "prompt" })), undefined);
  assert.equal(boundedPromptRequestId({ type: "prompt", get requestId() { throw new Error("must not read getter"); } }), undefined);
  assert.equal(boundedPromptRequestId(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("invalid caller object"); } })), undefined);
});

test("command serialization checks valid JSON and UTF-8 bytes before a command can be queued", () => {
  const valid = { type: "prompt", text: "hello", requestId: "prompt-1" };
  assert.equal(serializeClientCommand(valid), JSON.stringify(valid));
  assert.equal(serializeClientCommand({ type: "prompt", text: null }), null);
  assert.equal(serializeClientCommand({ type: "prompt", text: "x".repeat(CLIENT_COMMAND_MAX_TEXT_LENGTH + 1) }), null);
  const cyclic: Record<string, unknown> = { type: "codex_interaction_response", response: { id: "request", action: "submit" } };
  cyclic.self = cyclic;
  assert.equal(serializeClientCommand(cyclic), null);
  assert.equal(serializeClientCommand({ type: "codex_interaction_response", response: { id: "request", action: "submit", content: 1n } }), null);
  // Unknown MCP content stays valid, but its complete encoded payload still
  // shares the same transport budget. Multi-byte text must count as bytes.
  const content = "界".repeat(Math.floor(CLIENT_COMMAND_MAX_BYTES / 3));
  assert.equal(serializeClientCommand({ type: "codex_interaction_response", response: { id: "request", action: "submit", content } }), null);
});
