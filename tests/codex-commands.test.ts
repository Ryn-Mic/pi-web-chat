import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_COMMANDS, parseCodexReviewTarget } from "../server/codex-commands.ts";

test("Codex command catalog exposes only the Web-supported command surface", () => {
  assert.deepEqual(
    CODEX_COMMANDS.map((command) => command.name),
    [
      "settings",
      "new",
      "resume",
      "fork",
      "copy",
      "diff",
      "model",
      "reasoning",
      "rename",
      "status",
      "compact",
      "review",
    ],
  );
  assert.ok(CODEX_COMMANDS.every((command) => command.source === "builtin"));
  assert.equal(CODEX_COMMANDS.some((command) => ["delete", "logout", "plugins", "exit"].includes(command.name)), false);
});

test("Codex review arguments map to structured app-server targets", () => {
  assert.deepEqual(parseCodexReviewTarget(""), { ok: true, target: { type: "uncommittedChanges" } });
  assert.deepEqual(parseCodexReviewTarget(" --base origin/main "), {
    ok: true,
    target: { type: "baseBranch", branch: "origin/main" },
  });
  assert.deepEqual(parseCodexReviewTarget("--commit abc123"), {
    ok: true,
    target: { type: "commit", sha: "abc123", title: null },
  });
  assert.deepEqual(parseCodexReviewTarget("focus on authorization boundaries"), {
    ok: true,
    target: { type: "custom", instructions: "focus on authorization boundaries" },
  });
  assert.match(parseCodexReviewTarget("--base").error ?? "", /--base <branch>/);
  assert.match(parseCodexReviewTarget("--commit a b").error ?? "", /--commit <sha>/);
  assert.match(parseCodexReviewTarget("--unknown value").error ?? "", /Use \/review/);
});
