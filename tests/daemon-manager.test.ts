import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  legacyManagedHealthPid,
  looksLikeLegacyServerCommand,
  managedHealthPid,
} from "../extensions/daemon-manager.ts";

const instanceId = "a".repeat(64);

test("managed process ownership uses a cross-install health identity", () => {
  assert.equal(
    managedHealthPid(
      { ok: true, service: "pi-web-chat", managed: { instanceId, pid: 3141 } },
      instanceId,
    ),
    3141,
  );
  assert.equal(
    managedHealthPid(
      {
        ok: true,
        service: "pi-web-chat",
        managed: { instanceId: "b".repeat(64), pid: 3141 },
      },
      instanceId,
    ),
    null,
  );
  assert.equal(
    managedHealthPid(
      { ok: true, service: "another-service", managed: { instanceId, pid: 3141 } },
      instanceId,
    ),
    null,
  );
  assert.equal(
    managedHealthPid(
      { ok: true, service: "pi-web-chat", managed: { instanceId, pid: -1 } },
      instanceId,
    ),
    null,
  );
});

test("legacy ownership requires the exact old health shape and recorded listener pid", () => {
  const health = { ok: true, version: "0.1.109" };
  assert.equal(legacyManagedHealthPid(health, 3141, [3141]), 3141);
  assert.equal(legacyManagedHealthPid(health, 3141, [2718]), null);
  assert.equal(
    legacyManagedHealthPid(
      { ...health, service: "pi-web-chat" },
      3141,
      [3141],
    ),
    null,
  );
  assert.equal(legacyManagedHealthPid({ ok: true, version: "latest" }, 3141, [3141]), null);

  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/local/bin/node",
      "/usr/local/bin/node /tmp/web-chat/dist/index.js",
    ),
    true,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/bin/python",
      "python /tmp/web-chat/dist/index.js",
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/local/bin/node",
      "/usr/local/bin/node /tmp/web-chat/dist/index.js --other",
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/bin/python",
      "python wrapper.py node /tmp/web-chat/dist/index.js",
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/bin/bash",
      "bash -c node /tmp/web-chat/dist/index.js",
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/local/bin/node",
      "node -e server /tmp/web-chat/dist/index.js",
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/local/bin/node",
      "node /tmp/other.js /tmp/web-chat/dist/index.js",
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\web-chat\\dist\\index.js"',
    ),
    true,
  );
  assert.equal(
    looksLikeLegacyServerCommand(
      "/usr/local/bin/node",
      'node "--eval=serverCode // /tmp/web-chat/dist/index.js"',
    ),
    false,
  );
  assert.equal(
    looksLikeLegacyServerCommand("/usr/local/bin/node", "node dist/index.js"),
    false,
  );
});

function runManager(stateDir: string, source: string): string {
  const managerUrl = new URL("../extensions/daemon-manager.ts", import.meta.url).href;
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import * as manager from ${JSON.stringify(managerUrl)}; ${source}`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PI_WEB_TEST_STATE_DIR: stateDir,
      },
    },
  );
}

async function spawnLegacyServer(root: string): Promise<{
  child: ChildProcess;
  port: number;
}> {
  const distDir = join(root, "dist");
  const entry = join(distDir, "index.js");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    entry,
    `const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "0.1.109" }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\\n");
});
`,
    "utf8",
  );
  const child = spawn(process.execPath, [entry], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunk = await new Promise<Buffer>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`legacy test server did not become ready: ${stderr}`));
    }, 5_000);
    child.stderr?.on("data", (value: Buffer) => {
      stderr += value.toString("utf8");
    });
    child.stdout?.once("data", (value: Buffer) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `legacy test server exited before ready (${code ?? signal ?? "unknown"}): ${stderr}`,
        ),
      );
    });
  });
  const port = Number(chunk.toString("utf8").trim());
  assert.equal(Number.isSafeInteger(port) && port > 0, true);
  assert.equal(typeof child.pid, "number");
  return { child, port };
}

function stopChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* already stopped */
  }
}

test("new manager can query and stop a verified pre-instance daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-legacy-server-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-web-legacy-state-"));
  const { child, port } = await spawnLegacyServer(root);
  try {
    writeFileSync(join(stateDir, "pi-web-chat.pid"), `${child.pid}\n`, "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.port"), `${port}\n`, "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.host"), "127.0.0.1\n", "utf8");

    assert.equal(
      runManager(stateDir, "process.stdout.write(String(manager.readPid()));"),
      String(child.pid),
    );
    writeFileSync(join(stateDir, "pi-web-chat.instance"), "corrupt\n", "utf8");
    assert.equal(
      runManager(stateDir, "process.stdout.write(String(manager.readPid()));"),
      "null",
    );
    assert.equal(existsSync(join(stateDir, "pi-web-chat.pid")), true);
    unlinkSync(join(stateDir, "pi-web-chat.instance"));

    const stopped = JSON.parse(
      runManager(
        stateDir,
        "process.stdout.write(JSON.stringify(manager.stopServer({ waitMs: 0 })));",
      ),
    ) as { stopped: boolean; pid?: number; error?: string };
    assert.deepEqual(stopped, { stopped: true, pid: child.pid });
    assert.equal(existsSync(join(stateDir, "pi-web-chat.pid")), false);
    assert.equal(existsSync(join(stateDir, "pi-web-chat.port")), false);
    assert.equal(existsSync(join(stateDir, "pi-web-chat.host")), false);
  } finally {
    stopChild(child);
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("failed concurrent launcher preserves a different winner's state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-web-manager-race-"));
  const winnerInstanceId = "b".repeat(64);
  try {
    writeFileSync(join(stateDir, "pi-web-chat.pid"), `${process.pid}\n`, "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.port"), "9\n", "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.host"), "127.0.0.1\n", "utf8");
    writeFileSync(
      join(stateDir, "pi-web-chat.instance"),
      `${winnerInstanceId}\n`,
      "utf8",
    );

    const result = JSON.parse(
      runManager(
        stateDir,
        `process.stdout.write(JSON.stringify(manager.waitForServerReady("9", "127.0.0.1", 99999999, ${JSON.stringify(
          instanceId,
        )}, 100)));`,
      ),
    ) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /exited before becoming ready/);
    assert.equal(existsSync(join(stateDir, "pi-web-chat.pid")), true);
    assert.equal(existsSync(join(stateDir, "pi-web-chat.instance")), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("readiness does not accept another live server's health response", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-other-server-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-web-other-state-"));
  const { child, port } = await spawnLegacyServer(root);
  try {
    const result = JSON.parse(
      runManager(
        stateDir,
        `process.stdout.write(JSON.stringify(manager.waitForServerReady(${JSON.stringify(
          String(port),
        )}, "127.0.0.1", ${child.pid}, ${JSON.stringify(instanceId)}, 350)));`,
      ),
    ) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /unexpected managed health identity/);
  } finally {
    stopChild(child);
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unavailable health probe preserves state for an otherwise live pid", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-web-manager-state-"));
  try {
    writeFileSync(join(stateDir, "pi-web-chat.pid"), `${process.pid}\n`, "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.port"), "9\n", "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.host"), "127.0.0.1\n", "utf8");
    writeFileSync(join(stateDir, "pi-web-chat.instance"), `${instanceId}\n`, "utf8");
    const managerUrl = new URL("../extensions/daemon-manager.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { readPid } from ${JSON.stringify(managerUrl)}; process.stdout.write(String(readPid()));`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          PI_WEB_TEST_STATE_DIR: stateDir,
        },
      },
    );

    assert.equal(output, "null");
    assert.equal(existsSync(join(stateDir, "pi-web-chat.pid")), true);
    assert.equal(existsSync(join(stateDir, "pi-web-chat.instance")), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
