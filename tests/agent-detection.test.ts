import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLocalAgentCommands,
  formatAgentProbe,
  probeAgentCommand,
  type CommandProbeRunner,
} from "../cli/agent-detection.ts";
import { normalizeAgentBinaryEnvironment } from "../extensions/agent-binaries.ts";

test("agent command probe reports a detected version without a shell", () => {
  let observedOptions: Parameters<CommandProbeRunner>[2] | undefined;
  const runner: CommandProbeRunner = (_command, _args, options) => {
    observedOptions = options;
    return { status: 0, stdout: "codex-cli 0.149.1\n" };
  };

  const result = probeAgentCommand("codex", "codex", "path", runner);

  assert.deepEqual(result, {
    agent: "codex",
    command: "codex",
    source: "path",
    status: "detected",
    version: "codex-cli 0.149.1",
  });
  assert.equal(observedOptions?.shell, false);
  assert.equal(observedOptions?.timeout, 2_500);
});

test("agent command probe distinguishes missing, timeout, and failed commands", () => {
  const missing = probeAgentCommand("pi", "pi", "path", () => ({
    status: null,
    error: Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }),
  }));
  const timeout = probeAgentCommand("codex", "codex", "path", () => ({
    status: null,
    error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
  }));
  const failed = probeAgentCommand("codex", "codex", "path", () => ({
    status: 2,
    stderr: "sensitive diagnostic that must not be surfaced",
  }));

  assert.equal(missing.status, "missing");
  assert.equal(missing.reason, "not-found");
  assert.equal(timeout.status, "unusable");
  assert.equal(timeout.reason, "timeout");
  assert.equal(failed.status, "unusable");
  assert.equal(failed.reason, "failed");
  assert.doesNotMatch(formatAgentProbe(failed), /sensitive/);
});

test("local detection honors explicit Pi and Codex binary environment values", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandProbeRunner = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: `${command} 1.0.0\n` };
  };

  const probes = detectLocalAgentCommands(
    {
      PI_WEB_PI_BIN: "/opt/agents/pi-custom",
      PI_WEB_CODEX_BIN: "/opt/agents/codex-custom",
    },
    runner,
  );

  assert.deepEqual(calls, [
    { command: "/opt/agents/pi-custom", args: ["--version"] },
    { command: "/opt/agents/codex-custom", args: ["--version"] },
  ]);
  assert.deepEqual(probes.map((probe) => probe.source), ["env", "env"]);
});

test("relative executable overrides are resolved once from launcher cwd", () => {
  const commands: string[] = [];
  const runner: CommandProbeRunner = (command) => {
    commands.push(command);
    return { status: 0, stdout: "agent 1.0.0\n" };
  };

  detectLocalAgentCommands(
    { PI_WEB_PI_BIN: "pi", PI_WEB_CODEX_BIN: "./tools/codex" },
    runner,
    "/workspace/project",
  );

  assert.deepEqual(commands, ["pi", "/workspace/project/tools/codex"]);
  assert.equal(
    normalizeAgentBinaryEnvironment(
      { PI_WEB_CODEX_BIN: "./tools/codex" },
      "/workspace/project",
    ).PI_WEB_CODEX_BIN,
    "/workspace/project/tools/codex",
  );
});

test("probe formatting distinguishes packaged Pi runtime from external CLI diagnostics", () => {
  const line = formatAgentProbe({
    agent: "pi",
    command: "pi",
    source: "path",
    status: "missing",
    reason: "not-found",
  });

  assert.equal(line, "Pi CLI: not found");
  assert.doesNotMatch(line, /runtime unavailable/i);
});
