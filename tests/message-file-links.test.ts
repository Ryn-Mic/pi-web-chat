import assert from "node:assert/strict";
import { test } from "node:test";
import {
  messageFileHref,
  parseMessageFileHref,
  parseMessageFileReference,
  splitMessageFileReferences,
} from "../src/lib/message-file-links.ts";

const cwd = "/Users/example/project";

test("parseMessageFileReference normalizes project paths and source locations", () => {
  assert.deepEqual(parseMessageFileReference("src/components/App.tsx:42:7", cwd), {
    display: "src/components/App.tsx:42:7",
    path: "src/components/App.tsx",
    name: "App.tsx",
  });
  assert.deepEqual(parseMessageFileReference(`${cwd}/README.md#L12`, cwd), {
    display: `${cwd}/README.md#L12`,
    path: "README.md",
    name: "README.md",
  });
  assert.equal(parseMessageFileReference("../secret.txt", cwd), null);
  assert.equal(parseMessageFileReference("/tmp/outside.txt", cwd), null);
});

test("splitMessageFileReferences links files but not URLs, emails, dates, or versions", () => {
  const text = "See src/lib/chat.ts and package.json, not https://example.com/a.ts, dev@example.com, 26/8/13, or v0.1.86.";
  const files = splitMessageFileReferences(text, cwd)
    .filter((segment) => segment.type === "file")
    .map((segment) => segment.reference.path);
  assert.deepEqual(files, ["src/lib/chat.ts", "package.json"]);
});

test("file hrefs round-trip without treating URL links as files", () => {
  assert.deepEqual(parseMessageFileHref(messageFileHref("src/a file.ts"), cwd), {
    display: "src/a file.ts",
    path: "src/a file.ts",
    name: "a file.ts",
  });
  assert.deepEqual(parseMessageFileHref("src/components/App.tsx", cwd)?.path, "src/components/App.tsx");
  assert.equal(parseMessageFileHref("https://example.com/file.ts", cwd), null);
  assert.equal(parseMessageFileHref("#section", cwd), null);
});
