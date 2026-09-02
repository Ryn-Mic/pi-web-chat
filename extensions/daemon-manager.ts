import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentBinaryEnvironment } from "./agent-binaries.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const TEST_STATE_DIR = process.env.NODE_ENV === "test"
  ? process.env.PI_WEB_TEST_STATE_DIR?.trim()
  : undefined;
const STATE_DIR = TEST_STATE_DIR ? resolve(TEST_STATE_DIR) : join(homedir(), ".pi", "web-chat");
const PID_FILE = join(STATE_DIR, "pi-web-chat.pid");
const PORT_FILE = join(STATE_DIR, "pi-web-chat.port");
const HOST_FILE = join(STATE_DIR, "pi-web-chat.host");
const INSTANCE_FILE = join(STATE_DIR, "pi-web-chat.instance");
export const LOG_FILE = join(STATE_DIR, "pi-web-chat.log");
export const TOKEN_FILE = join(STATE_DIR, "token");
export const DEFAULT_PORT = "3141";
const DEFAULT_HOST = "127.0.0.1";
const LAN_HOST = "0.0.0.0";
const MANAGED_DAEMON_ENV = "PI_WEB_DAEMON_MANAGED";
const MANAGED_DAEMON_INSTANCE_ENV = "PI_WEB_DAEMON_INSTANCE_ID";

export type StartResult =
  | { ok: true; port: string; host: string; already: true; pid: number }
  | {
      ok: true;
      port: string;
      host: string;
      already: false;
      pid: number;
      instanceId: string;
    }
  | { ok: false; error: string };

export type StopResult =
  | { stopped: true; pid: number; error?: undefined }
  | { stopped: false; pid?: number; error?: string };

export type DaemonAction = "start" | "stop" | "status" | "restart" | "rftoken";

export type ParsedWebArgs = {
  action: DaemonAction;
  port: string;
  host: string;
  /** True when user explicitly set port (so restart can keep previous otherwise). */
  portExplicit: boolean;
  /** True when user explicitly set host / --lan. */
  hostExplicit: boolean;
  /** Access token for the web UI (passed as PI_WEB_TOKEN). */
  token?: string;
};

function readInstanceId(): string | null {
  try {
    const value = readFileSync(INSTANCE_FILE, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function hasManagedState(): boolean {
  return [PID_FILE, PORT_FILE, HOST_FILE, INSTANCE_FILE].some((file) => existsSync(file));
}

function readStoredPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Only ESRCH proves the recorded process is gone; EPERM and probe failures are unknown. */
function processDefinitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function readPort(): string {
  try {
    if (existsSync(PORT_FILE)) {
      const port = readFileSync(PORT_FILE, "utf8").trim();
      if (port) return port;
    }
  } catch {
    /* ignore */
  }
  return defaultPort();
}

export function readHost(): string {
  try {
    if (existsSync(HOST_FILE)) {
      const host = readFileSync(HOST_FILE, "utf8").trim();
      if (host) return host;
    }
  } catch {
    /* ignore */
  }
  return defaultHost();
}

export function defaultPort(): string {
  return process.env.PORT ?? DEFAULT_PORT;
}

export function defaultHost(): string {
  return process.env.HOST ?? DEFAULT_HOST;
}

export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

export function urlFor(port: string, host = readHost()): string {
  const displayHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" ? "localhost" : host;
  const needsBrackets = displayHost.includes(":") && !displayHost.startsWith("[");
  const formatted = needsBrackets ? `[${displayHost}]` : displayHost;
  return `http://${formatted}:${port}`;
}

export function describeServer(port: string, host: string, pid: number): string {
  const bindNote = isLoopbackHost(host) ? "" : ` (bind ${host})`;
  return `${urlFor(port, host)}${bindNote} (pid ${pid})`;
}

/** Find PIDs listening on the given port (best effort; empty when unavailable). */
function pidsOnPort(port: string): number[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
        const localAddress = columns[1] ?? "";
        const localPort = localAddress
          .slice(localAddress.lastIndexOf(":") + 1)
          .replace(/\]$/, "");
        const state = columns[3]?.toUpperCase();
        const pid = Number(columns[4]);
        if (
          localPort === port &&
          state === "LISTENING" &&
          Number.isSafeInteger(pid) &&
          pid > 0
        ) {
          pids.add(pid);
        }
      }
      return [...pids];
    }

    const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [
      ...new Set(
        out
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      ),
    ];
  } catch {
    return [];
  }
}

function pidOnPort(port: string): number | null {
  return pidsOnPort(port)[0] ?? null;
}

/** Extract a verified managed PID from an unauthenticated health response. */
export function managedHealthPid(value: unknown, instanceId: string): number | null {
  if (!value || typeof value !== "object") return null;
  const health = value as {
    ok?: unknown;
    service?: unknown;
    managed?: { instanceId?: unknown; pid?: unknown };
  };
  const pid = health.managed?.pid;
  if (
    health.ok !== true ||
    health.service !== "pi-web-chat" ||
    health.managed?.instanceId !== instanceId ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return null;
  }
  return pid;
}

/**
 * Recognize the exact health shape emitted before managed instance identities
 * existed. The recorded PID must also own the recorded listening port before a
 * legacy daemon can be managed; the response alone is intentionally insufficient.
 */
export function legacyManagedHealthPid(
  value: unknown,
  storedPid: number,
  listenerPids: Iterable<number>,
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const health = value as Record<string, unknown>;
  const keys = Object.keys(health).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "ok" ||
    keys[1] !== "version" ||
    health.ok !== true ||
    typeof health.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      health.version,
    )
  ) {
    return null;
  }
  return [...listenerPids].includes(storedPid) ? storedPid : null;
}

function readManagedHealth(port: string, host: string): unknown | null {
  const target = probeHost(host);
  const probe = `
const port = process.argv[1];
const host = process.argv[2];
const url = "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port + "/api/health";
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
  if (!response.ok) process.exit(1);
  process.stdout.write(await response.text());
} catch {
  process.exit(1);
}
`;
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probe, port, target],
      {
        encoding: "utf8",
        timeout: 2_500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return JSON.parse(out) as unknown;
  } catch {
    return null;
  }
}

type VerifiedManagedServer = {
  pid: number;
  port: string;
  host: string;
  instanceId: string | null;
  version: string | null;
};

export type ManagedServerStatus = Omit<VerifiedManagedServer, "instanceId">;

export function installedPackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" && manifest.version.trim().length > 0
      ? manifest.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

function healthVersion(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version : null;
}

function isAbsoluteServerEntry(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  return (
    !normalized.startsWith("-") &&
    (normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.startsWith("//")) &&
    /\/dist\/index\.js$/.test(normalized)
  );
}

export function looksLikeLegacyServerCommand(
  executable: string,
  commandLine: string,
): boolean {
  const executableName = basename(executable.trim().replaceAll("\\", "/"));
  const argv: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (const character of commandLine.trim()) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        argv.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (quote !== null) return false;
  if (token) argv.push(token);

  const invokedExecutable = basename((argv[0] ?? "").replaceAll("\\", "/"));
  const entry = (argv[1] ?? "").replaceAll("\\", "/");
  return (
    /^(?:node|nodejs)(?:\.exe)?$/i.test(executableName) &&
    /^(?:node|nodejs)(?:\.exe)?$/i.test(invokedExecutable) &&
    argv.length === 2 &&
    isAbsoluteServerEntry(entry)
  );
}

/** Legacy daemons need an OS-level executable check before they may be signalled. */
function isLegacyServerProcess(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      const executable = argv[0]?.replaceAll("\\", "/") ?? "";
      const entry = argv[1]?.replaceAll("\\", "/") ?? "";
      return (
        argv.length === 2 &&
        /(?:^|\/)(?:node|nodejs)$/.test(executable) &&
        isAbsoluteServerEntry(entry)
      );
    }

    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
            "if($null -eq $p){exit 1};" +
            "$p|Select-Object ExecutablePath,CommandLine|ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          timeout: 2_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const processInfo = JSON.parse(out) as {
        ExecutablePath?: unknown;
        CommandLine?: unknown;
      };
      return (
        typeof processInfo.ExecutablePath === "string" &&
        typeof processInfo.CommandLine === "string" &&
        looksLikeLegacyServerCommand(
          processInfo.ExecutablePath,
          processInfo.CommandLine,
        )
      );
    }

    const executable = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const command = execFileSync(
      "ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return looksLikeLegacyServerCommand(executable, command);
  } catch {
    return false;
  }
}

function verifyManagedServer(): VerifiedManagedServer | null {
  const instanceId = readInstanceId();
  // A present-but-invalid instance file is corrupt new-format state, not a
  // legacy state marker. Never downgrade it to the weaker migration path.
  if (existsSync(INSTANCE_FILE) && instanceId === null) return null;
  const port = readPort();
  const host = readHost();
  const health = readManagedHealth(port, host);
  const storedPid = readStoredPid();
  const pid =
    instanceId !== null
      ? managedHealthPid(health, instanceId)
      : storedPid !== null
        ? legacyManagedHealthPid(health, storedPid, pidsOnPort(port))
        : null;
  if (pid === null) return null;

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PID_FILE, `${pid}\n`, "utf8");
  } catch {
    /* health identity remains authoritative if pid recovery cannot persist */
  }
  return { pid, port, host, instanceId, version: healthVersion(health) };
}

export function readManagedServerStatus(): ManagedServerStatus | null {
  const verified = verifyManagedServer();
  if (verified !== null) {
    const { pid, port, host, version } = verified;
    return { pid, port, host, version };
  }

  const storedPid = readStoredPid();
  if (hasManagedState() && storedPid !== null && processDefinitelyGone(storedPid)) {
    clearStateFilesIfOwnedBy(storedPid);
  }
  return null;
}

export function readPid(): number | null {
  return readManagedServerStatus()?.pid ?? null;
}

export function startServer(port: string, host: string, token?: string): StartResult {
  if (!existsSync(SERVER)) {
    return {
      ok: false,
      error:
        "build missing (dist/index.js). Rebuild the package (`npm run build`) or reinstall pi-web-chat.",
    };
  }

  const existing = readPid();
  if (existing !== null) {
    return {
      ok: true,
      port: readPort(),
      host: readHost(),
      already: true,
      pid: existing,
    };
  }

  if (hasManagedState()) {
    return {
      ok: false,
      error:
        "managed daemon state exists but its health identity could not be verified; state was preserved",
    };
  }

  if (isPortListening(port, host)) {
    const occupant = pidOnPort(port);
    return {
      ok: false,
      error: `port ${port} is already in use by another process${
        occupant !== null ? ` (pid ${occupant})` : ""
      } — not pi-web-chat`,
    };
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const instanceId = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...normalizeAgentBinaryEnvironment(process.env, process.cwd()),
      PORT: port,
      HOST: host,
      [MANAGED_DAEMON_ENV]: "1",
      [MANAGED_DAEMON_INSTANCE_ENV]: instanceId,
      ...(token ? { PI_WEB_TOKEN: token } : {}),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  if (!child.pid) return { ok: false, error: "failed to spawn server process" };

  // The server writes state only after a successful bind, avoiding stale state
  // when the spawned process immediately exits with EADDRINUSE.
  return { ok: true, port, host, already: false, pid: child.pid, instanceId };
}

function clearStateFiles(): void {
  for (const file of [PID_FILE, PORT_FILE, HOST_FILE, INSTANCE_FILE]) {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

/** Only clear state that still belongs to the process being reaped. */
function clearStateFilesIfOwnedBy(pid: number, instanceId?: string | null): boolean {
  if (readStoredPid() !== pid) return false;
  const currentInstanceId = readInstanceId();
  if (instanceId === null && currentInstanceId !== null) return false;
  if (
    typeof instanceId === "string" &&
    currentInstanceId !== null &&
    currentInstanceId !== instanceId
  ) {
    return false;
  }
  clearStateFiles();
  return true;
}

function sleepSync(ms: number): void {
  const clamped = Math.max(1, Math.min(ms, 5_000));
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${clamped})`,
      ],
      { stdio: "ignore", timeout: clamped + 1_000 },
    );
  } catch {
    /* ignore timeout / platform quirks */
  }
}

/** Check whether something is already listening on the given host:port. */
function isPortListening(port: string, host: string): boolean {
  const target =
    host === "0.0.0.0" || host === "::" || host === "[::]" || host === "localhost"
      ? "127.0.0.1"
      : host.replace(/^\[|\]$/g, "");
  const script = `
const net = require("net");
const s = net.connect(Number(process.argv[1]), process.argv[2]);
s.once("connect", () => { s.destroy(); process.exit(0); });
s.once("error", () => process.exit(1));
s.setTimeout(800, () => { s.destroy(); process.exit(1); });
`;
  try {
    execFileSync(process.execPath, ["-e", script, port, target], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function stopServer(opts: { waitMs?: number } = {}): StopResult {
  const hadState = hasManagedState();
  const verified = verifyManagedServer();
  if (verified === null) {
    if (!hadState) return { stopped: false };
    const storedPid = readStoredPid();
    if (storedPid !== null && processDefinitelyGone(storedPid)) {
      clearStateFilesIfOwnedBy(storedPid);
      return { stopped: false };
    }
    const port = readPort();
    const host = readHost();
    return {
      stopped: false,
      error: `unable to verify the managed pi-web-chat instance at ${urlFor(port, host)}; state was preserved`,
    };
  }

  const confirmed = verifyManagedServer();
  if (
    confirmed === null ||
    confirmed.pid !== verified.pid ||
    confirmed.instanceId !== verified.instanceId
  ) {
    return {
      stopped: false,
      pid: verified.pid,
      error: "managed daemon identity changed before stop; state was preserved",
    };
  }

  const { pid, instanceId } = confirmed;
  if (instanceId === null && !isLegacyServerProcess(pid)) {
    return {
      stopped: false,
      pid,
      error:
        "legacy daemon is healthy, but its process entry could not be verified; state was preserved",
    };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      return {
        stopped: false,
        pid,
        error: `unable to stop managed server pid ${pid}${code ? ` (${code})` : ""}`,
      };
    }
  }

  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && isProcessAlive(pid)) sleepSync(50);
    if (isProcessAlive(pid)) {
      return {
        stopped: false,
        pid,
        error: `managed server pid ${pid} did not exit; state was preserved`,
      };
    }
  }

  clearStateFilesIfOwnedBy(pid, instanceId);
  return { stopped: true, pid };
}

export function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const args =
      process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* optional */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function probeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "localhost") {
    return "127.0.0.1";
  }
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/** Block until the daemon serves /api/health, exits, or reaches the timeout. */
export function waitForServerReady(
  port: string,
  host: string,
  pid: number,
  instanceId: string,
  timeoutMs = 45_000,
): { ok: true } | { ok: false; error: string } {
  const probe = probeHost(host);
  const waiter = `
const port = process.argv[1];
const host = process.argv[2];
const pid = Number(process.argv[3]);
const timeoutMs = Number(process.argv[4]);
const instanceId = process.argv[5];
const healthUrl = "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port + "/api/health";
const started = Date.now();
function alive() {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
(async () => {
  let last = "not ready";
  while (Date.now() - started < timeoutMs) {
    if (!alive()) {
      process.stderr.write("dead");
      process.exit(2);
    }
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const health = await res.json();
        if (
          health &&
          health.ok === true &&
          health.service === "pi-web-chat" &&
          health.managed &&
          health.managed.instanceId === instanceId &&
          health.managed.pid === pid
        ) process.exit(0);
        last = "unexpected managed health identity";
      } else {
        last = "HTTP " + res.status;
      }
    } catch (err) {
      last = err && err.message ? err.message : String(err);
    }
    await sleep(150);
  }
  process.stderr.write(last);
  process.exit(1);
})();
`;

  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        waiter,
        port,
        probe,
        String(pid),
        String(timeoutMs),
        instanceId,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
        timeout: timeoutMs + 5_000,
      },
    );
    return { ok: true };
  } catch (error) {
    const failure = error as {
      status?: number | null;
      stderr?: string;
      signal?: string | null;
      message?: string;
    };
    if (failure.status === 2 || !isProcessAlive(pid)) {
      clearStateFilesIfOwnedBy(pid, instanceId);
      return {
        ok: false,
        error: `server process exited before becoming ready (see ${LOG_FILE})`,
      };
    }
    const detail = (failure.stderr ?? "").trim() || failure.message || "unknown error";
    return {
      ok: false,
      error: `server did not become ready within ${Math.round(timeoutMs / 1000)}s (${detail})`,
    };
  }
}

/** Parse options shared by the standalone launcher, `pi --web`, and `/web`. */
export function parseWebOptions(
  tokens: string[],
  defaults: { port: string; host: string } = {
    port: defaultPort(),
    host: defaultHost(),
  },
): ParsedWebArgs | { error: string } {
  let action: DaemonAction = "start";
  let port = defaults.port;
  let host = defaults.host;
  let portExplicit = false;
  let hostExplicit = false;
  let sawAction = false;
  let token: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i]!;
    if (
      arg === "stop" ||
      arg === "status" ||
      arg === "restart" ||
      arg === "rftoken" ||
      arg === "--restart"
    ) {
      if (sawAction) return { error: `unexpected extra action '${arg}'` };
      action = arg === "--restart" ? "restart" : arg;
      sawAction = true;
      continue;
    }

    if (arg === "--token" || arg === "-t") {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) return { error: `${arg} requires a value` };
      token = value;
      continue;
    }

    if (arg.startsWith("--token=")) {
      const value = arg.slice("--token=".length);
      if (!value) return { error: "--token requires a value" };
      token = value;
      continue;
    }

    if (arg === "--lan" || arg === "--public" || arg === "lan" || arg === "public") {
      host = LAN_HOST;
      hostExplicit = true;
      continue;
    }

    if (arg === "--host" || arg === "-H" || arg === "host") {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) {
        return { error: `${arg} requires an address (e.g. 0.0.0.0)` };
      }
      host = value;
      hostExplicit = true;
      continue;
    }

    if (arg.startsWith("--host=")) {
      const value = arg.slice("--host=".length);
      if (!value) return { error: "--host requires an address (e.g. 0.0.0.0)" };
      host = value;
      hostExplicit = true;
      continue;
    }

    if (arg.startsWith("-H=")) {
      const value = arg.slice("-H=".length);
      if (!value) return { error: "-H requires an address (e.g. 0.0.0.0)" };
      host = value;
      hostExplicit = true;
      continue;
    }

    if (/^\d+$/.test(arg)) {
      port = arg;
      portExplicit = true;
      continue;
    }

    return {
      error: `unknown argument '${arg}' (use port, --host <addr>, --lan, --token <value>, stop, status, restart, rftoken)`,
    };
  }

  return { action, port, host, portExplicit, hostExplicit, token };
}

/** Preserve the previous bind unless the caller explicitly selects a target. */
export function resolveLaunchTarget(parsed: ParsedWebArgs): { port: string; host: string } {
  return {
    port: parsed.portExplicit ? parsed.port : readPort(),
    host: parsed.hostExplicit ? parsed.host : readHost(),
  };
}

export function rotateToken(): string {
  const token = randomBytes(32).toString("hex");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

export function managedRestartPortError(
  action: string,
  portExplicit: boolean,
): string | undefined {
  if (action !== "restart" || portExplicit) return undefined;
  return `managed restart requires an explicit port; use pi --web ${DEFAULT_PORT} restart`;
}
