import {
  DEFAULT_PORT,
  LOG_FILE,
  TOKEN_FILE,
  describeServer,
  installedPackageVersion,
  isLoopbackHost,
  openBrowser,
  parseWebOptions,
  readManagedServerStatus,
  resolveLaunchTarget,
  rotateToken,
  startServer,
  stopServer,
  urlFor,
  waitForServerReady,
  type ParsedWebArgs,
  type ManagedServerStatus,
  type StartResult,
  type StopResult,
} from "../extensions/daemon-manager.ts";
import {
  detectLocalAgentCommands,
  formatAgentProbe,
  type AgentCommandProbe,
} from "./agent-detection.ts";

export type CliIO = {
  out(line: string): void;
  error(line: string): void;
};

export type StandaloneCliDependencies = {
  detectAgents(): AgentCommandProbe[];
  parseOptions(tokens: string[]): ParsedWebArgs | { error: string };
  readManagedServerStatus(): ManagedServerStatus | null;
  describeServer(port: string, host: string, pid: number): string;
  resolveLaunchTarget(parsed: ParsedWebArgs): { port: string; host: string };
  startServer(port: string, host: string, token?: string): StartResult;
  stopServer(options?: { waitMs?: number }): StopResult;
  waitForServerReady(
    port: string,
    host: string,
    pid: number,
    instanceId: string,
  ): { ok: true } | { ok: false; error: string };
  rotateToken(): string;
  isLoopbackHost(host: string): boolean;
  urlFor(port: string, host?: string): string;
  openBrowser(url: string): void;
  version(): string;
  logFile: string;
  tokenFile: string;
};

const defaultIO: CliIO = {
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

const defaults: StandaloneCliDependencies = {
  detectAgents: () => detectLocalAgentCommands(),
  parseOptions: parseWebOptions,
  readManagedServerStatus,
  describeServer,
  resolveLaunchTarget,
  startServer,
  stopServer,
  waitForServerReady,
  rotateToken,
  isLoopbackHost,
  urlFor,
  openBrowser: (url) => {
    if (process.env.PI_WEB_NO_OPEN !== "1") openBrowser(url);
  },
  version: installedPackageVersion,
  logFile: LOG_FILE,
  tokenFile: TOKEN_FILE,
};

export const STANDALONE_CLI_HELP = `pi-web-chat — Web UI for Pi and Codex

Usage:
  pi-web-chat [start] [port] [--host <addr> | --lan] [--token <value>]
  pi-web-chat status
  pi-web-chat stop
  pi-web-chat <port> restart
  pi-web-chat rftoken
  pi-web-chat doctor

Options:
  -H, --host <addr>  Bind address (default 127.0.0.1)
      --lan          Bind 0.0.0.0 for trusted LAN access
  -t, --token <val> Set the Web access token for this launch
  -h, --help        Show this help
  -v, --version     Show the package version

Legacy compatibility:
  pi --web and /web remain available and manage the same daemon.`;

function printAgentDetection(probes: AgentCommandProbe[], io: CliIO): void {
  io.out("Agent detection:");
  io.out("  Pi runtime: packaged dependency — @earendil-works/pi-coding-agent SDK");
  for (const probe of probes) io.out(`  ${formatAgentProbe(probe)}`);

  const pi = probes.find((probe) => probe.agent === "pi");
  const codex = probes.find((probe) => probe.agent === "codex");
  if (pi?.status !== "detected") {
    io.out("  note: Pi CLI is optional; packaged Pi runtime remains available");
  }
  if (codex?.status !== "detected") {
    io.out("  note: Codex sessions require a working Codex CLI; Pi remains available");
  }
}

function launch(
  parsed: ParsedWebArgs,
  verb: "started" | "restarted",
  deps: StandaloneCliDependencies,
  io: CliIO,
  target?: { port: string; host: string },
  probes?: AgentCommandProbe[],
): number {
  printAgentDetection(probes ?? deps.detectAgents(), io);
  const { port, host } = target ?? parsed;
  const result = deps.startServer(port, host, parsed.token);
  if (!result.ok) {
    io.error(`pi-web-chat: ${result.error}`);
    return 1;
  }

  const url = deps.urlFor(result.port, result.host);
  const summary = deps.describeServer(result.port, result.host, result.pid);
  if (result.already) {
    io.out(`pi-web-chat already running — ${summary}`);
    deps.openBrowser(url);
    return 0;
  }

  io.out(`pi-web-chat starting (pid ${result.pid})…`);
  const ready = deps.waitForServerReady(
    result.port,
    result.host,
    result.pid,
    result.instanceId,
  );
  if (!ready.ok) {
    io.error(`pi-web-chat: ${ready.error}`);
    return 1;
  }

  io.out(`pi-web-chat ${verb} — ${summary}`);
  if (!deps.isLoopbackHost(result.host)) {
    io.out("  warning: bound beyond loopback — auth (token + 2FA) is enforced");
  }
  io.out("  stop:    pi-web-chat stop");
  io.out(`  restart: pi-web-chat ${result.port} restart`);
  io.out("  status:  pi-web-chat status");
  io.out("  agents:  Pi + Codex (select per new session in Web settings)");
  io.out(`  logs:    ${deps.logFile}`);
  io.out(`  auth:    token & 2FA — see ${deps.logFile} (or ${deps.tokenFile})`);
  deps.openBrowser(url);
  return 0;
}

export function runStandaloneCli(
  argv: string[] = process.argv.slice(2),
  overrides: Partial<StandaloneCliDependencies> = {},
  io: CliIO = defaultIO,
): number {
  const deps = { ...defaults, ...overrides };

  if (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!)) {
    io.out(STANDALONE_CLI_HELP);
    return 0;
  }
  if (argv.length === 1 && ["version", "--version", "-v"].includes(argv[0]!)) {
    io.out(deps.version());
    return 0;
  }
  if (argv.length === 1 && argv[0] === "doctor") {
    io.out(`pi-web-chat ${deps.version()}`);
    printAgentDetection(deps.detectAgents(), io);
    return 0;
  }

  const tokens = argv[0] === "start" ? argv.slice(1) : argv;
  const parsed = deps.parseOptions(tokens);
  if ("error" in parsed) {
    io.error(`pi-web-chat: ${parsed.error}`);
    io.error("Run `pi-web-chat --help` for usage.");
    return 1;
  }

  if (parsed.action === "restart" && !parsed.portExplicit) {
    io.error(
      `pi-web-chat: managed restart requires an explicit port; use pi-web-chat ${DEFAULT_PORT} restart`,
    );
    return 1;
  }

  if (parsed.action === "status") {
    const status = deps.readManagedServerStatus();
    if (status === null) {
      io.out("pi-web-chat is not running");
      return 1;
    }
    io.out(
      `pi-web-chat running — ${deps.describeServer(status.port, status.host, status.pid)}`,
    );
    const installedVersion = deps.version();
    if (status.version !== null && status.version !== installedVersion) {
      io.out(
        `  version mismatch: running v${status.version}; installed v${installedVersion}`,
      );
      io.out(`  restart: pi-web-chat ${status.port} restart`);
    }
    return 0;
  }

  if (parsed.action === "stop") {
    const result = deps.stopServer({ waitMs: 3_000 });
    if (result.error) {
      io.error(`pi-web-chat: ${result.error}`);
      return 1;
    }
    io.out(
      result.stopped
        ? `pi-web-chat stopped (pid ${result.pid})`
        : "pi-web-chat is not running",
    );
    return 0;
  }

  if (parsed.action === "rftoken") {
    const token = deps.rotateToken();
    io.out(
      `pi-web-chat: access token rotated — ${token} (stored in ${deps.tokenFile}, applies on next login)`,
    );
    return 0;
  }

  if (parsed.action === "restart") {
    const target = deps.resolveLaunchTarget(parsed);
    const probes = deps.detectAgents();
    const result = deps.stopServer({ waitMs: 5_000 });
    if (result.error) {
      io.error(`pi-web-chat: ${result.error}`);
      return 1;
    }
    if (result.stopped) io.out(`pi-web-chat stopped (pid ${result.pid})`);
    return launch(parsed, "restarted", deps, io, target, probes);
  }

  return launch(parsed, "started", deps, io);
}
