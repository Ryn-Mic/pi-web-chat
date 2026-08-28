import { isAbsolute, resolve } from "node:path";

const AGENT_BINARY_ENV_KEYS = ["PI_WEB_PI_BIN", "PI_WEB_CODEX_BIN"] as const;

/**
 * Resolve an explicit executable path from the launcher's working directory.
 * Bare command names continue to use PATH in both the launcher and daemon.
 */
export function resolveAgentBinaryOverride(command: string, cwd = process.cwd()): string {
  const trimmed = command.trim();
  if (!trimmed || isAbsolute(trimmed)) return trimmed;
  if (!trimmed.includes("/") && !trimmed.includes("\\")) return trimmed;
  return resolve(cwd, trimmed);
}

/** Keep detection and the detached daemon on the same executable targets. */
export function normalizeAgentBinaryEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...env };
  for (const key of AGENT_BINARY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) normalized[key] = resolveAgentBinaryOverride(value, cwd);
  }
  return normalized;
}
