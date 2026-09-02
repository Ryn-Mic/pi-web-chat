import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyVersionRelationship,
  deriveVersionNotice,
} from "../src/lib/version.ts";

test("version relationship distinguishes newer server, equality, and stale server", () => {
  assert.equal(classifyVersionRelationship("0.1.112", "0.1.113"), "server-newer");
  assert.equal(classifyVersionRelationship("0.1.113", "0.1.113"), "equal");
  assert.equal(classifyVersionRelationship("0.1.113", "0.1.112"), "server-older");
});

test("version relationship follows SemVer prerelease precedence", () => {
  assert.equal(classifyVersionRelationship("1.0.0-rc.1", "1.0.0"), "server-newer");
  assert.equal(classifyVersionRelationship("1.0.0-rc.2", "1.0.0-rc.1"), "server-older");
  assert.equal(
    classifyVersionRelationship("1.0.0-rc.99999999999999999998", "1.0.0-rc.99999999999999999999"),
    "server-newer",
  );
  assert.equal(classifyVersionRelationship("1.0.0+client", "1.0.0+server"), "equal");
});

test("non-standard unequal versions preserve the compatible update path", () => {
  assert.equal(classifyVersionRelationship("dev-client", "dev-server"), "different");
  assert.deepEqual(deriveVersionNotice("dev-client", "dev-server", ["development build"]), {
    updateAvailable: true,
    serverRestartRequired: false,
    updateVersion: "dev-server",
    updateNotes: ["development build"],
  });
});

test("stale server notices discard its older release notes", () => {
  assert.deepEqual(deriveVersionNotice("0.1.113", "0.1.112", ["old release note"]), {
    updateAvailable: false,
    serverRestartRequired: true,
    updateVersion: "0.1.112",
    updateNotes: [],
  });
});
