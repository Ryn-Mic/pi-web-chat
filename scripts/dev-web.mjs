#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";
import { createServer } from "vite";
import { devBackendPort } from "./dev-web-options.ts";

export { devBackendPort };

export async function main(env = process.env, dependencies = { waitOn, createServer }) {
  const port = devBackendPort(env);
  // Vite reads the same normalized port when loading vite.config.ts.
  process.env.PI_WEB_DEV_PORT = port;
  await dependencies.waitOn({ resources: [`tcp:127.0.0.1:${port}`], timeout: 30_000 });
  const server = await dependencies.createServer();
  await server.listen();
  server.printUrls();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
