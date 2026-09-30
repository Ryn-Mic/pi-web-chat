import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedRestartPortError, parseWebOptions } from "../extensions/pi-web-chat.ts";

test("web restart accepts an explicit recovery port", () => {
  assert.deepEqual(parseWebOptions(["restart", "3141"], { port: "3141", host: "127.0.0.1" }), {
    action: "restart",
    port: "3141",
    host: "127.0.0.1",
    portExplicit: true,
    hostExplicit: false,
    token: undefined,
  });
  assert.equal(managedRestartPortError("restart", true), undefined);
});

test("managed web restart rejects an implicit daemon-state port", () => {
  assert.equal(
    managedRestartPortError("restart", false),
    "managed restart requires an explicit port; use pi --web 3141 restart",
  );
});

test("web launch options enforce valid ports and hosts", () => {
  const defaults = { port: "3141", host: "127.0.0.1" };
  for (const port of ["0", "65536", "999999999999999999999"]) {
    assert.match((parseWebOptions([port, "restart"], defaults) as { error: string }).error, /1 and 65535/);
  }
  for (const host of ["http://localhost", "hello world", "[localhost]", "-invalid"] ) {
    assert.ok("error" in parseWebOptions(["3141", "restart", `--host=${host}`], defaults));
  }
  assert.ok(!("error" in parseWebOptions(["65535", "--host", "::1"], defaults)));
});

test("web host and lan options are parsed independently from the access token", () => {
  const defaults = { port: "3141", host: "127.0.0.1" };
  assert.deepEqual(parseWebOptions(["--lan"], defaults), {
    action: "start",
    port: "3141",
    host: "0.0.0.0",
    portExplicit: false,
    hostExplicit: true,
    token: undefined,
  });
  assert.deepEqual(parseWebOptions(["--host", "127.0.0.2", "--token=secret"], defaults), {
    action: "start",
    port: "3141",
    host: "127.0.0.2",
    portExplicit: false,
    hostExplicit: true,
    token: "secret",
  });
});

test("Pi CLI and command token rotation never expose the generated credential", () => {
  const extensionUrl = new URL("../extensions/pi-web-chat.ts", import.meta.url).href;
  for (const mode of ["cli", "command"]) {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-web-token-output-"));
    try {
      const source = mode === "cli"
        ? 'process.argv = ["node", "pi", "--web", "rftoken"]; extension({ registerFlag() {} });'
        : 'let command; extension({ registerFlag() {}, registerCommand(name, value) { command = value; } }); await command.handler("rftoken", { ui: { notify(message) { process.stdout.write(message); } } });';
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import extension from ${JSON.stringify(extensionUrl)}; ${source}`], {
        encoding: "utf8", timeout: 5_000,
        env: { ...process.env, NODE_ENV: "test", PI_WEB_TEST_STATE_DIR: stateDir },
      });
      const token = readFileSync(join(stateDir, "token"), "utf8").trim();
      assert.equal(token.length, 64);
      assert.match(output, /access token rotated/);
      assert.equal(output.includes(token), false);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  }
});
