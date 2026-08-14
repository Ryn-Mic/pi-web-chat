import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createCwdBoundCoreTools } from "../server/runtime-tools.ts";

test("runtime core tools keep the session cwd when an extension overrides bash", async () => {
  const hostCwd = mkdtempSync(join(tmpdir(), "pi-web-chat-host-"));
  const sessionCwd = mkdtempSync(join(tmpdir(), "pi-web-chat-session-"));

  try {
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      resourceLoaderOptions: {
        extensionFactories: [
          (pi) => {
            const hostBash = createBashTool(hostCwd);
            pi.registerTool({ ...hostBash });
          },
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(sessionCwd),
      customTools: createCwdBoundCoreTools(sessionCwd, services.settingsManager),
    });

    try {
      const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
      assert.ok(bash);
      const result = await bash.execute(
        "cwd-test",
        { command: "pwd" },
        undefined,
        undefined,
      );
      const output = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      assert.equal(realpathSync(output), realpathSync(sessionCwd));
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(hostCwd, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});
