#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env.PI_WEB_E2E_ROOT ?? "/tmp/pi-web-chat-file-preview-e2e";
const home = join(base, "home");
const project = join(base, "project");
rmSync(base, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# Preview fixture\n\nHello from the file viewer.\n");
writeFileSync(join(project, "notes.txt"), "plain text\n");
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
console.log(JSON.stringify({ base, home, project }));
