#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

if (!existsSync(cli)) {
  console.error("pi-web-chat: missing dist/cli.js");
  console.error("  Dev:    npm run build && npm start");
  console.error("  Package consumers: reinstall/update @ryn-mic/web-chat.");
  process.exit(1);
}

await import(pathToFileURL(cli).href);
