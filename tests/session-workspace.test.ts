import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionWorkspace, type WorkspaceClient } from "../src/lib/session-workspace.ts";
import {
  clearComposerDraftIfMatches,
  getComposerDraft,
  setComposerDraft,
} from "../src/lib/composer-drafts.ts";

type FakeState = {
  sessionId: string | null;
  connection: "connecting" | "connected" | "disconnected";
  snapshot: null;
};

class FakeClient implements WorkspaceClient<FakeState> {
  state: FakeState = { sessionId: null, connection: "connecting", snapshot: null };
  disposed = false;
  focusToken = 0;
  private listeners = new Set<() => void>();
  private readonly onBound: (sessionId: string) => void;

  constructor(onBound: (sessionId: string) => void) {
    this.onBound = onBound;
  }

  connect(sessionId: string | null) {
    this.state = { ...this.state, sessionId, connection: "connected" };
    this.emit();
  }

  bind(sessionId: string) {
    this.state = { ...this.state, sessionId };
    this.onBound(sessionId);
    this.emit();
  }

  dispose() {
    this.disposed = true;
  }

  clearComposerFocus() {
    this.focusToken = 0;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

function createWorkspace() {
  const clients: FakeClient[] = [];
  const workspace = new SessionWorkspace<FakeState, FakeClient>((_, onBound) => {
    const client = new FakeClient(onBound);
    clients.push(client);
    return client;
  });
  return { workspace, clients };
}

test("clears a background tab's pending focus when switching tabs", () => {
  const { workspace, clients } = createWorkspace();

  workspace.open("session-a");
  clients[0].focusToken = 1;
  workspace.open("session-b");

  assert.equal(clients[0].focusToken, 0);
});

test("keeps multiple session clients alive while switching the active tab", () => {
  const { workspace, clients } = createWorkspace();

  workspace.open("session-a");
  workspace.open("session-b");
  workspace.activate("session-a");

  assert.equal(clients.length, 2);
  assert.equal(workspace.activeKey, "session-a");
  assert.deepEqual(
    workspace.getTabsSnapshot().map((tab) => tab.sessionId),
    ["session-a", "session-b"],
  );
  assert.equal(clients[0].disposed, false);
  assert.equal(clients[1].disposed, false);
});

test("keeps a draft tab key stable while updating its bound session id", () => {
  const { workspace, clients } = createWorkspace();

  workspace.open(null);
  const draftKey = workspace.activeKey;
  assert.ok(draftKey?.startsWith("draft:"));

  clients[0].bind("session-created");
  clients[0].bind("session-forked");

  assert.equal(workspace.activeKey, draftKey);
  assert.deepEqual(
    workspace.getTabsSnapshot().map((tab) => ({ key: tab.key, sessionId: tab.sessionId })),
    [{ key: draftKey, sessionId: "session-forked" }],
  );
});

test("keeps an existing tab identity stable when a fork changes its session id", () => {
  const { workspace, clients } = createWorkspace();

  workspace.open("session-a");
  const tabKey = workspace.activeKey;
  clients[0].bind("session-b");

  assert.equal(workspace.activeKey, tabKey);
  assert.equal(workspace.getTabsSnapshot()[0]?.sessionId, "session-b");
  assert.equal(workspace.open("session-b"), clients[0]);
  assert.equal(workspace.activeKey, tabKey);
});

test("closes only the selected client and activates the remaining tab", () => {
  const { workspace, clients } = createWorkspace();

  workspace.open("session-a");
  workspace.open("session-b");
  workspace.close("session-b");

  assert.equal(clients[1].disposed, true);
  assert.equal(clients[0].disposed, false);
  assert.equal(workspace.activeKey, "session-a");
  assert.deepEqual(
    workspace.getTabsSnapshot().map((tab) => tab.sessionId),
    ["session-a"],
  );
});

test("keeps unsent composer drafts isolated by session tab", () => {
  setComposerDraft("tab-a", { text: "message A", images: [] });
  setComposerDraft("tab-b", { text: "message B", images: [] });

  assert.equal(getComposerDraft("tab-a").text, "message A");
  assert.equal(getComposerDraft("tab-b").text, "message B");
  assert.equal(getComposerDraft("tab-c").text, "");
});

test("only clears a composer draft when it still matches the submitted prompt", () => {
  setComposerDraft("tab-match", { text: "submitted", images: [] });
  setComposerDraft("tab-changed", { text: "new input", images: [] });

  clearComposerDraftIfMatches("tab-match", { text: "submitted", images: [] });
  clearComposerDraftIfMatches("tab-changed", { text: "submitted", images: [] });

  assert.equal(getComposerDraft("tab-match").text, "");
  assert.equal(getComposerDraft("tab-changed").text, "new input");
});
