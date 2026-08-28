import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MANAGED_DAEMON_ENV,
  MANAGED_DAEMON_INSTANCE_ENV,
  isManagedDaemon,
  writeManagedDaemonState,
} from "../server/daemon-state.ts";

test("debug servers do not overwrite managed daemon state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-daemon-state-"));
  try {
    assert.equal(isManagedDaemon({}), false);
    assert.equal(
      writeManagedDaemonState(dir, { pid: 42, port: 3241, host: "127.0.0.1" }, {}),
      false,
    );
    assert.equal(
      writeManagedDaemonState(
        dir,
        { pid: 42, port: 3241, host: "127.0.0.1" },
        { [MANAGED_DAEMON_ENV]: "1" },
      ),
      false,
    );
    assert.throws(() => readFileSync(join(dir, "pi-web-chat.port"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed launchers persist pid, port, host, and instance identity after bind", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-daemon-state-"));
  try {
    const env = {
      [MANAGED_DAEMON_ENV]: "1",
      [MANAGED_DAEMON_INSTANCE_ENV]: "instance-314",
    };
    assert.equal(
      writeManagedDaemonState(dir, { pid: 314, port: 3141, host: "127.0.0.1" }, env),
      true,
    );
    assert.equal(readFileSync(join(dir, "pi-web-chat.pid"), "utf8"), "314\n");
    assert.equal(readFileSync(join(dir, "pi-web-chat.port"), "utf8"), "3141\n");
    assert.equal(readFileSync(join(dir, "pi-web-chat.host"), "utf8"), "127.0.0.1\n");
    assert.equal(
      readFileSync(join(dir, "pi-web-chat.instance"), "utf8"),
      "instance-314\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
