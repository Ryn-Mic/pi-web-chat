import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANAGED_DAEMON_ENV = "PI_WEB_DAEMON_MANAGED";

type DaemonState = {
  pid: number;
  port: number;
  host: string;
};

/** Only a server launched by the pi --web daemon command may own its state files. */
export function isManagedDaemon(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[MANAGED_DAEMON_ENV] === "1";
}

/** Persist daemon discovery state after a successful bind. Debug servers skip this. */
export function writeManagedDaemonState(
  stateDir: string,
  state: DaemonState,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!isManagedDaemon(env)) return false;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "pi-web-chat.pid"), `${state.pid}\n`, "utf8");
  writeFileSync(join(stateDir, "pi-web-chat.port"), `${state.port}\n`, "utf8");
  writeFileSync(join(stateDir, "pi-web-chat.host"), `${state.host}\n`, "utf8");
  return true;
}
