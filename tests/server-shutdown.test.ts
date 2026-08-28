import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
    server.on("error", reject);
  });
}

test("server exits cleanly after Ctrl-C", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-shutdown-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_2FA: "off",
      PI_WEB_TOKEN: "shutdown-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not start")), 10_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`server exited before startup: ${code ?? signal}`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (!chunk.toString("utf8").includes("pi-web-chat server:")) return;
        clearTimeout(timeout);
        resolve();
      });
      child.stderr.resume();
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("server ignored SIGINT")), 3_000);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      },
    );
    assert.equal(child.kill("SIGINT"), true);
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
