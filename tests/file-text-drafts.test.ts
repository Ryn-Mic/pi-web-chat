import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setAuthStatus, setSessionToken } from "../src/lib/auth.ts";
import { confirmDiscardWorkspaceTextDrafts, discardTextFileDraft, discardWorkspaceTextDrafts, editorText, getTextFileDraft, mergeTextFileDrafts, setTextFileDraft, sourceText } from "../src/lib/file-text-drafts.ts";

afterEach(() => setSessionToken(null));

test("source editing keeps BOM and consistent line ending conventions", () => {
  for (const source of ["a\nb\n", "\uFEFFa\r\nb\r\n", "a\rb\r"]) {
    assert.equal(sourceText(editorText(source), source), source);
  }
});

test("drafts isolate chat workspace, cwd, path and authenticated account", () => {
  setSessionToken("draft-test-a");
  const draft = { source: { text: "before", revision: "one", name: "file.txt" }, text: "after" };
  setTextFileDraft("/project", "file.txt", draft, "chat-a");
  assert.equal(getTextFileDraft("/project", "file.txt", "chat-a"), draft);
  assert.equal(getTextFileDraft("/project", "file.txt", "chat-b"), undefined);
  assert.equal(getTextFileDraft("/other", "file.txt", "chat-a"), undefined);
  assert.equal(getTextFileDraft("/project", "other.txt", "chat-a"), undefined);
  setSessionToken("draft-test-b");
  assert.equal(getTextFileDraft("/project", "file.txt", "chat-a"), undefined);
});

test("binding a draft chat retains its file draft and saving clears it", () => {
  setSessionToken("draft-test-binding");
  const draft = { source: { text: "before", revision: "one", name: "file.txt" }, text: "after" };
  setTextFileDraft("/project", "file.txt", draft, "draft-chat");
  mergeTextFileDrafts("draft-chat", "session-chat");
  assert.equal(getTextFileDraft("/project", "file.txt", "draft-chat"), undefined);
  assert.equal(getTextFileDraft("/project", "file.txt", "session-chat"), draft);
  discardTextFileDraft("/project", "file.txt", "session-chat");
  assert.equal(getTextFileDraft("/project", "file.txt", "session-chat"), undefined);
});

test("signing out clears transient drafts without a discard dialog", () => {
  setAuthStatus("authenticated");
  setSessionToken("draft-test-logout");
  setTextFileDraft("/project", "file.txt", { source: { text: "before", revision: "one", name: "file.txt" }, text: "private draft" }, "chat-a");
  setAuthStatus("unauthenticated");
  assert.equal(getTextFileDraft("/project", "file.txt", "chat-a"), undefined);
});

test("confirmation preserves workspace drafts until the remote delete succeeds", () => {
  setAuthStatus("authenticated");
  setSessionToken("draft-test-remote-delete");
  const fakeGlobal = globalThis as unknown as { window?: Window };
  const originalWindow = fakeGlobal.window;
  fakeGlobal.window = { confirm: () => true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window;
  try {
    const draft = { source: { text: "before", revision: "one", name: "file.txt" }, text: "not lost if delete fails" };
    setTextFileDraft("/project", "file.txt", draft, "chat-a");
    assert.equal(confirmDiscardWorkspaceTextDrafts("chat-a", "discard?", false), true);
    assert.equal(getTextFileDraft("/project", "file.txt", "chat-a"), draft);
    discardWorkspaceTextDrafts("chat-a");
    assert.equal(getTextFileDraft("/project", "file.txt", "chat-a"), undefined);
  } finally {
    if (originalWindow) fakeGlobal.window = originalWindow;
    else delete fakeGlobal.window;
  }
});
