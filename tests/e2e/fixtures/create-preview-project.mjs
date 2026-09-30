#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env.PI_WEB_E2E_ROOT ?? "/tmp/pi-web-chat-file-preview-e2e";
const home = join(base, "home");
const project = join(base, "project");
const messageFileSessionId = "e2e-file-links";
rmSync(base, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
// Browser fixtures must never enumerate or attach the user's native sessions.
writeFileSync(join(base, "fake-codex.mjs"), `#!/usr/bin/env node
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize" ? {}
    : message.method === "remoteControl/status/read" ? { status: "disabled" }
    : { data: [], nextCursor: null };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`, { mode: 0o755 });
writeFileSync(join(project, "README.md"), "# Preview fixture\n\nHello from the file viewer.\n");
writeFileSync(join(project, "notes.txt"), "plain text\n");
writeFileSync(join(project, "Dockerfile"), "FROM node:22\n");
writeFileSync(join(project, "edit-draft.txt"), "draft before\n");
writeFileSync(join(project, "edit-conflict.txt"), "conflict before\n");
writeFileSync(join(project, "edit-mobile.txt"), "mobile before\n");
writeFileSync(join(project, "unknown-binary.bin"), Buffer.from([0, 1, 2, 3]));
writeFileSync(join(project, "active.html"), "<script>parent.__previewPwned = true</script><h1>Visible text</h1>");
writeFileSync(join(project, "active.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.__previewPwned=true</script></svg>');
execFileSync("git", ["-C", project, "init", "-q"]);
execFileSync("git", ["-C", project, "config", "user.email", "e2e@example.com"]);
execFileSync("git", ["-C", project, "config", "user.name", "E2E Test"]);
execFileSync("git", ["-C", project, "add", "README.md", "notes.txt"]);
execFileSync("git", ["-C", project, "commit", "-qm", "seed preview files"]);
writeFileSync(join(project, "README.md"), "# Preview fixture\n\nChanged in the working tree.\n");
writeFileSync(join(project, "notes.txt"), "plain text changed\n");
execFileSync("git", ["-C", project, "add", "README.md", "notes.txt"]);
execFileSync("git", ["-C", project, "commit", "-qm", "update preview files"]);
writeFileSync(join(project, "README.md"), "# Preview fixture\n\nChanged after the commit.\n");

const sessionDir = join(home, ".pi", "agent", "sessions", "e2e-project");
mkdirSync(sessionDir, { recursive: true });
const timestamp = "2026-08-13T12:34:56.000Z";
const sessionEntries = [
  { type: "session", version: 3, id: messageFileSessionId, timestamp, cwd: project },
  {
    type: "message",
    id: "user-file-link",
    parentId: null,
    timestamp,
    message: { role: "user", content: [{ type: "text", text: "show linked files" }] },
  },
  {
    type: "message",
    id: "assistant-file-link",
    parentId: "user-file-link",
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Open README.md or [website](https://example.com).",
        },
      ],
    },
  },
];
writeFileSync(
  join(sessionDir, `2026-08-13T12-34-56-000Z_${messageFileSessionId}.jsonl`),
  `${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);
console.log(JSON.stringify({ base, home, project, messageFileSessionId }));
