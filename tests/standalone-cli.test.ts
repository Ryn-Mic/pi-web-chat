import assert from "node:assert/strict";
import test from "node:test";
import { runStandaloneCli, type CliIO, type StandaloneCliDependencies } from "../cli/index.ts";
import type { AgentCommandProbe } from "../cli/agent-detection.ts";

function captureIO(): { io: CliIO; out: string[]; errors: string[] } {
  const out: string[] = [];
  const errors: string[] = [];
  return {
    io: { out: (line) => out.push(line), error: (line) => errors.push(line) },
    out,
    errors,
  };
}

const probes: AgentCommandProbe[] = [
  { agent: "pi", command: "pi", source: "path", status: "detected", version: "pi 1.0" },
  {
    agent: "codex",
    command: "codex",
    source: "path",
    status: "missing",
    reason: "not-found",
  },
];

function daemonDefaults(): Partial<StandaloneCliDependencies> {
  return {
    detectAgents: () => probes,
    version: () => "0.1.110",
    readPid: () => null,
    readPort: () => "3141",
    readHost: () => "127.0.0.1",
    describeServer: (port, host, pid) => `http://${host}:${port} (pid ${pid})`,
    resolveLaunchTarget: (parsed) => ({ port: parsed.port, host: parsed.host }),
    startServer: (port, host) => ({
      ok: true,
      port,
      host,
      already: false,
      pid: 42,
      instanceId: "a".repeat(64),
    }),
    stopServer: () => ({ stopped: false }),
    waitForServerReady: () => ({ ok: true }),
    rotateToken: () => "new-token",
    isLoopbackHost: () => true,
    urlFor: (port, host = "127.0.0.1") => `http://${host}:${port}`,
    openBrowser: () => {},
    logFile: "/tmp/pi-web-chat.log",
    tokenFile: "/tmp/pi-web-chat-token",
  };
}

test("standalone CLI help and version do not touch daemon state", () => {
  let reads = 0;
  const deps = { ...daemonDefaults(), readPid: () => (reads++, null) };
  const help = captureIO();
  const version = captureIO();

  assert.equal(runStandaloneCli(["--help"], deps, help.io), 0);
  assert.match(help.out.join("\n"), /pi-web-chat status/);
  assert.equal(runStandaloneCli(["--version"], deps, version.io), 0);
  assert.deepEqual(version.out, ["0.1.110"]);
  assert.equal(reads, 0);
});

test("standalone CLI doctor distinguishes packaged Pi runtime and external commands", () => {
  const captured = captureIO();

  assert.equal(runStandaloneCli(["doctor"], daemonDefaults(), captured.io), 0);
  assert.match(captured.out.join("\n"), /Pi runtime: packaged dependency/);
  assert.match(captured.out.join("\n"), /Pi CLI: detected — pi 1\.0/);
  assert.match(captured.out.join("\n"), /Codex CLI: not found/);
  assert.match(captured.out.join("\n"), /Codex sessions require a working Codex CLI/);
});

test("standalone status never starts a missing daemon", () => {
  let starts = 0;
  const captured = captureIO();
  const deps = {
    ...daemonDefaults(),
    startServer: (..._args: Parameters<StandaloneCliDependencies["startServer"]>) => {
      starts++;
      return { ok: false as const, error: "must not start" };
    },
  };

  assert.equal(runStandaloneCli(["status"], deps, captured.io), 1);
  assert.deepEqual(captured.out, ["pi-web-chat is not running"]);
  assert.equal(starts, 0);
});

test("standalone start uses shared daemon lifecycle and command-specific hints", () => {
  let opened = "";
  const captured = captureIO();
  const deps = { ...daemonDefaults(), openBrowser: (url: string) => { opened = url; } };

  assert.equal(runStandaloneCli(["start", "3200"], deps, captured.io), 0);
  assert.match(captured.out.join("\n"), /Agent detection:/);
  assert.match(captured.out.join("\n"), /pi-web-chat started — http:\/\/127\.0\.0\.1:3200/);
  assert.match(captured.out.join("\n"), /restart: pi-web-chat 3200 restart/);
  assert.equal(opened, "http://127.0.0.1:3200");
});

test("standalone managed restart requires an explicit port before stopping", () => {
  let stops = 0;
  const captured = captureIO();
  const deps = {
    ...daemonDefaults(),
    stopServer: () => {
      stops++;
      return { stopped: true, pid: 42 };
    },
  };

  assert.equal(runStandaloneCli(["restart"], deps, captured.io), 1);
  assert.match(captured.errors.join("\n"), /pi-web-chat 3141 restart/);
  assert.equal(stops, 0);
});

test("standalone restart preserves the previous host resolved before state cleanup", () => {
  let stateAvailable = true;
  let launchedHost = "";
  const captured = captureIO();
  const deps: Partial<StandaloneCliDependencies> = {
    ...daemonDefaults(),
    resolveLaunchTarget: (parsed) => ({
      port: parsed.port,
      host: stateAvailable ? "0.0.0.0" : "127.0.0.1",
    }),
    stopServer: () => {
      stateAvailable = false;
      return { stopped: true, pid: 42 };
    },
    startServer: (port, host) => {
      launchedHost = host;
      return {
        ok: true,
        port,
        host,
        already: false,
        pid: 43,
        instanceId: "b".repeat(64),
      };
    },
  };

  assert.equal(runStandaloneCli(["3141", "restart"], deps, captured.io), 0);
  assert.equal(launchedHost, "0.0.0.0");
});

test("standalone stop reports a preserved-state failure", () => {
  const captured = captureIO();
  const deps: Partial<StandaloneCliDependencies> = {
    ...daemonDefaults(),
    stopServer: () => ({
      stopped: false,
      pid: 42,
      error: "managed server pid 42 did not exit; state was preserved",
    }),
  };

  assert.equal(runStandaloneCli(["stop"], deps, captured.io), 1);
  assert.match(captured.errors.join("\n"), /state was preserved/);
});
