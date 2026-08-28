import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { resolveAgentBinaryOverride } from "../extensions/agent-binaries.ts";

export type AgentCommand = "pi" | "codex";
export type AgentProbeStatus = "detected" | "missing" | "unusable";
export type AgentProbeSource = "env" | "path";

export type AgentCommandProbe = {
  agent: AgentCommand;
  command: string;
  source: AgentProbeSource;
  status: AgentProbeStatus;
  version?: string;
  reason?: "not-found" | "timeout" | "failed";
};

export type ProbeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

export type CommandProbeRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => ProbeResult;

const defaultRunner: CommandProbeRunner = (command, args, options) =>
  spawnSync(command, args, options);

function oneLineVersion(output: string | undefined): string | undefined {
  const line = output?.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return undefined;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function probeAgentCommand(
  agent: AgentCommand,
  command: string,
  source: AgentProbeSource,
  runner: CommandProbeRunner = defaultRunner,
): AgentCommandProbe {
  const result = runner(command, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 2_500,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error?.code === "ENOENT") {
    return { agent, command, source, status: "missing", reason: "not-found" };
  }

  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    return { agent, command, source, status: "unusable", reason: "timeout" };
  }

  if (result.error || result.status !== 0) {
    return { agent, command, source, status: "unusable", reason: "failed" };
  }

  return {
    agent,
    command,
    source,
    status: "detected",
    version: oneLineVersion(result.stdout) ?? oneLineVersion(result.stderr),
  };
}

export function detectLocalAgentCommands(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runner: CommandProbeRunner = defaultRunner,
  cwd = process.cwd(),
): AgentCommandProbe[] {
  const rawPiOverride = env.PI_WEB_PI_BIN?.trim();
  const rawCodexOverride = env.PI_WEB_CODEX_BIN?.trim();
  const piOverride = rawPiOverride
    ? resolveAgentBinaryOverride(rawPiOverride, cwd)
    : undefined;
  const codexOverride = rawCodexOverride
    ? resolveAgentBinaryOverride(rawCodexOverride, cwd)
    : undefined;

  return [
    probeAgentCommand("pi", piOverride || "pi", piOverride ? "env" : "path", runner),
    probeAgentCommand(
      "codex",
      codexOverride || "codex",
      codexOverride ? "env" : "path",
      runner,
    ),
  ];
}

export function formatAgentProbe(probe: AgentCommandProbe): string {
  const label = probe.agent === "pi" ? "Pi CLI" : "Codex CLI";
  const target = probe.source === "env" ? ` (${probe.command})` : "";
  if (probe.status === "detected") {
    return `${label}: detected${probe.version ? ` — ${probe.version}` : ""}${target}`;
  }
  if (probe.status === "missing") {
    return `${label}: not found${target}`;
  }
  const reason = probe.reason === "timeout" ? "probe timed out" : "version probe failed";
  return `${label}: unusable (${reason})${target}`;
}
