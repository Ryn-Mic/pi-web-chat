import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PreviewContextExpiredError,
  PreviewContextNotFoundError,
  PreviewContextStore,
} from "../server/preview-context.ts";

const root = "/projects/demo";

function makeMetadata(overrides: { path?: string; name?: string } = {}) {
  return {
    name: overrides.name ?? "README.md",
    size: 5,
    mimeType: "text/markdown",
    mtimeMs: 1_234_567_890,
    dev: 64,
    ino: 1000,
    ...overrides,
  };
}

test("creates a context and consumes it", () => {
  const clock = { now: 1_000 };
  const store = new PreviewContextStore({
    now: () => clock.now,
    createId: () => "raw-capability-id",
  });
  const created = store.create({
    sessionToken: "session-a",
    root,
    path: "README.md",
    metadata: makeMetadata(),
    theme: "dark",
    locale: "en-US",
  });
  assert.equal(created.id, "raw-capability-id");
  assert.equal(typeof created.expiresAt, "string");

  const record = store.consume("raw-capability-id");
  assert.equal(record.theme, "dark");
  assert.equal(record.locale, "en-US");
  assert.equal(record.root, root);
  assert.equal(record.path, "README.md");
  assert.equal(record.name, "README.md");
  assert.equal(record.size, 5);
  assert.equal(record.sessionFingerprint.length, 64);
  assert.equal(record.firstUsedAt, clock.now);
});

test("expires after 5 minutes if never used", () => {
  const clock = { now: 0 };
  const store = new PreviewContextStore({
    now: () => clock.now,
    createId: () => "id",
  });
  store.create({
    sessionToken: "session-a",
    root,
    path: "README.md",
    metadata: makeMetadata(),
    theme: "light",
    locale: "en-US",
  });

  clock.now = 5 * 60 * 1000 + 1;
  assert.throws(() => store.consume("id"), PreviewContextExpiredError);
});

test("after first use, valid for 10 minutes from first use", () => {
  const clock = { now: 1_000 };
  const store = new PreviewContextStore({
    now: () => clock.now,
    createId: () => "id",
  });
  store.create({
    sessionToken: "session-a",
    root,
    path: "README.md",
    metadata: makeMetadata(),
    theme: "light",
    locale: "en-US",
  });

  store.consume("id");
  clock.now = 1_000 + 10 * 60 * 1000;
  assert.equal(store.consume("id").theme, "light");

  clock.now = 1_000 + 10 * 60 * 1000 + 1;
  assert.throws(() => store.consume("id"), PreviewContextExpiredError);
});

test("two synchronous consumes both succeed and share firstUsedAt", () => {
  const store = new PreviewContextStore({
    now: () => 0,
    createId: () => "id",
  });
  store.create({
    sessionToken: "session-a",
    root,
    path: "README.md",
    metadata: makeMetadata(),
    theme: "light",
    locale: "en-US",
  });

  const a = store.consume("id");
  const b = store.consume("id");
  assert.equal(a.firstUsedAt, b.firstUsedAt);
  assert.equal(a.theme, b.theme);
});

test("evicts oldest context per fingerprint after 16", () => {
  let counter = 0;
  const store = new PreviewContextStore({
    now: () => counter,
    createId: () => `id-${counter++}`,
  });

  for (let i = 0; i < 16; i++) {
    store.create({
      sessionToken: "session-a",
      root,
      path: `f${i}.md`,
      metadata: makeMetadata({ path: `f${i}.md`, name: `f${i}.md` }),
      theme: "light",
      locale: "en-US",
    });
  }
  assert.equal(store.size, 16);

  store.create({
    sessionToken: "session-a",
    root,
    path: "new.md",
    metadata: makeMetadata({ path: "new.md", name: "new.md" }),
    theme: "dark",
    locale: "en-US",
  });
  assert.equal(store.size, 16);

  assert.throws(() => store.consume("id-0"), PreviewContextNotFoundError);
  assert.equal(store.consume("id-15").theme, "light");
  assert.equal(store.consume("id-16").theme, "dark");
});

test("eviction is scoped to session fingerprint", () => {
  let counter = 0;
  const store = new PreviewContextStore({
    now: () => counter,
    createId: () => `id-${counter++}`,
  });

  for (let i = 0; i < 16; i++) {
    store.create({
      sessionToken: "session-a",
      root,
      path: `a${i}.md`,
      metadata: makeMetadata({ path: `a${i}.md`, name: `a${i}.md` }),
      theme: "light",
      locale: "en-US",
    });
  }
  store.create({
    sessionToken: "session-b",
    root,
    path: "b.md",
    metadata: makeMetadata({ path: "b.md", name: "b.md" }),
    theme: "dark",
    locale: "en-US",
  });
  assert.equal(store.size, 17);

  store.create({
    sessionToken: "session-a",
    root,
    path: "a17.md",
    metadata: makeMetadata({ path: "a17.md", name: "a17.md" }),
    theme: "light",
    locale: "en-US",
  });
  assert.equal(store.size, 17);

  assert.throws(() => store.consume("id-0"), PreviewContextNotFoundError);
  assert.equal(store.consume("id-16").theme, "dark");
});

test("deleteBySessionToken removes only that session's contexts", () => {
  let counter = 0;
  const store = new PreviewContextStore({
    now: () => 0,
    createId: () => `id-${counter++}`,
  });

  store.create({
    sessionToken: "session-a",
    root,
    path: "a1.md",
    metadata: makeMetadata({ path: "a1.md", name: "a1.md" }),
    theme: "light",
    locale: "en-US",
  });
  store.create({
    sessionToken: "session-a",
    root,
    path: "a2.md",
    metadata: makeMetadata({ path: "a2.md", name: "a2.md" }),
    theme: "light",
    locale: "en-US",
  });
  store.create({
    sessionToken: "session-b",
    root,
    path: "b.md",
    metadata: makeMetadata({ path: "b.md", name: "b.md" }),
    theme: "dark",
    locale: "en-US",
  });

  assert.equal(store.deleteBySessionToken("session-a"), 2);
  assert.equal(store.size, 1);
  assert.throws(() => store.consume("id-0"), PreviewContextNotFoundError);
  assert.throws(() => store.consume("id-1"), PreviewContextNotFoundError);
  assert.equal(store.consume("id-2").theme, "dark");
});

test("cleanup removes only expired contexts", () => {
  const clock = { now: 0 };
  let counter = 0;
  const store = new PreviewContextStore({
    now: () => clock.now,
    createId: () => `id-${counter++}`,
  });

  store.create({
    sessionToken: "session-a",
    root,
    path: "old.md",
    metadata: makeMetadata({ path: "old.md", name: "old.md" }),
    theme: "light",
    locale: "en-US",
  });
  clock.now = 5 * 60 * 1000 + 1;
  store.create({
    sessionToken: "session-a",
    root,
    path: "new.md",
    metadata: makeMetadata({ path: "new.md", name: "new.md" }),
    theme: "dark",
    locale: "en-US",
  });

  assert.equal(store.size, 2);
  assert.equal(store.cleanup(), 1);
  assert.equal(store.size, 1);
  assert.throws(() => store.consume("id-0"), PreviewContextNotFoundError);
  assert.equal(store.consume("id-1").theme, "dark");
});

test("consume throws not found for unknown id", () => {
  const store = new PreviewContextStore();
  assert.throws(() => store.consume("not-a-real-id"), PreviewContextNotFoundError);
});
