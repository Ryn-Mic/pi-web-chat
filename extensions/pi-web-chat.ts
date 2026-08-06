/**
 * pi-web-chat extension
 *
 * - `pi --web`  → start UI server daemon and exit (no TUI)
 * - `/web`      → start | stop | status | <port> [--host <addr>|--lan] inside a normal pi session
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const STATE_DIR = join(homedir(), ".pi", "web-chat");
const PID_FILE = join(STATE_DIR, "pi-web-chat.pid");
const PORT_FILE = join(STATE_DIR, "pi-web-chat.port");
const HOST_FILE = join(STATE_DIR, "pi-web-chat.host");
const LOG_FILE = join(STATE_DIR, "pi-web-chat.log");
const TOKEN_FILE = join(STATE_DIR, "token");
const DEFAULT_PORT = "3141";
const DEFAULT_HOST = "127.0.0.1";
const LAN_HOST = "0.0.0.0";

type StartResult =
  | { ok: true; port: string; host: string; already: boolean; pid: number }
  | { ok: false; error: string };

function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws if not running
    return pid;
  } catch {
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    return null;
  }
}

function readPort(): string {
  try {
    if (existsSync(PORT_FILE)) {
      const p = readFileSync(PORT_FILE, "utf8").trim();
      if (p) return p;
    }
  } catch {
    /* ignore */
  }
  return process.env.PORT ?? DEFAULT_PORT;
}

function readHost(): string {
  try {
    if (existsSync(HOST_FILE)) {
      const h = readFileSync(HOST_FILE, "utf8").trim();
      if (h) return h;
    }
  } catch {
    /* ignore */
  }
  return process.env.HOST ?? DEFAULT_HOST;
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function urlFor(port: string, host = readHost()): string {
  const displayHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" ? "localhost" : host;
  const needsBrackets = displayHost.includes(":") && !displayHost.startsWith("[");
  const formatted = needsBrackets ? `[${displayHost}]` : displayHost;
  return `http://${formatted}:${port}`;
}

function describeServer(port: string, host: string, pid: number): string {
  const bindNote = isLoopbackHost(host) ? "" : ` (bind ${host})`;
  return `${urlFor(port, host)}${bindNote} (pid ${pid})`;
}

/**
 * Find the PID listening on the given port (best effort; null when unavailable).
 * Uses lsof (macOS/Linux). Falls back to null on other platforms or errors.
 */
function pidOnPort(port: string): number | null {
  try {
    const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether a PID's command line marks it as one of our server processes. */
function isOurServerProcess(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /pi-web-chat|dist[\/\\]index\.js/.test(out);
  } catch {
    return false;
  }
}

/**
 * An orphaned server (its pid file was lost/stale) may still hold the port.
 * Rebuild the state files so the daemon can be managed again (stop/restart).
 */
function adoptOrphanedServer(port: string, host: string, pid: number): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, `${pid}\n`, "utf8");
  writeFileSync(PORT_FILE, `${port}\n`, "utf8");
  writeFileSync(HOST_FILE, `${host}\n`, "utf8");
}

function startServer(port: string, host: string, token?: string): StartResult {
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

  // Port open but no (valid) pid file. If the listener is our own server — an
  // orphan whose state files were lost — adopt it instead of failing.
  if (isPortListening(port, host)) {
    const occupant = pidOnPort(port);
    if (occupant !== null && isOurServerProcess(occupant)) {
      adoptOrphanedServer(port, host, occupant);
      return { ok: true, port, host, already: true, pid: occupant };
    }
    return {
      ok: false,
      error: `port ${port} is already in use by another process${
        occupant !== null ? ` (pid ${occupant})` : ""
      } — not pi-web-chat`,
    };
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: port,
      HOST: host,
      ...(token ? { PI_WEB_TOKEN: token } : {}),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  if (!child.pid) {
    return { ok: false, error: "failed to spawn server process" };
  }

  // The pid/port/host files are written by the server itself after a
  // successful bind (server/index.ts listen callback). Writing them here first
  // would leave the pid of a port-conflict-dead process behind and loop the
  // next start with EADDRINUSE.
  return { ok: true, port, host, already: false, pid: child.pid };
}

function clearStateFiles(): void {
  for (const file of [PID_FILE, PORT_FILE, HOST_FILE]) {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
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

/**
 * Check whether something is already listening on the given host:port (sync).
 * Checked before spawning to avoid an EADDRINUSE crash / pid-file race.
 */
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

function stopServer(opts: { waitMs?: number } = {}): {
  stopped: boolean;
  pid?: number;
} {
  let pid = readPid();
  // No pid file: our server may still hold the port as an orphan (lost state
  // files). Find and stop it too.
  if (pid === null) {
    const occupant = pidOnPort(readPort());
    if (occupant !== null && isOurServerProcess(occupant)) {
      pid = occupant;
    }
  }

  if (pid === null) {
    clearStateFiles();
    return { stopped: false };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }

  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      sleepSync(50);
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      const killDeadline = Date.now() + 1_000;
      while (Date.now() < killDeadline && isProcessAlive(pid)) {
        sleepSync(50);
      }
    }
  }

  clearStateFiles();
  return { stopped: true, pid };
}

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args =
      process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* optional */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Host used for local readiness probes (wildcard binds → loopback). */
function probeHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "localhost") {
    return "127.0.0.1";
  }
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Block until the daemon serves /api/health (or the process dies / timeout).
 * Implemented via a short-lived Node child so the extension factory can stay
 * synchronous and exit before the pi TUI starts.
 */
function waitForServerReady(
  port: string,
  host: string,
  pid: number,
  timeoutMs = 45_000,
): { ok: true } | { ok: false; error: string } {
  const probe = probeHost(host);
  // Inline waiter keeps the package free of extra bin files.
  const waiter = `
const port = process.argv[1];
const host = process.argv[2];
const pid = Number(process.argv[3]);
const timeoutMs = Number(process.argv[4]);
const healthUrl = "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port + "/api/health";
const started = Date.now();
function alive() {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
(async () => {
  let last = "not ready";
  while (Date.now() - started < timeoutMs) {
    if (!alive()) {
      process.stderr.write("dead");
      process.exit(2);
    }
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (res.ok) process.exit(0);
      last = "HTTP " + res.status;
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
      ["--input-type=module", "-e", waiter, port, probe, String(pid), String(timeoutMs)],
      {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
        timeout: timeoutMs + 5_000,
      },
    );
    return { ok: true };
  } catch (err) {
    const e = err as {
      status?: number | null;
      stderr?: string;
      signal?: string | null;
      message?: string;
    };
    if (e.status === 2 || !isProcessAlive(pid)) {
      clearStateFiles();
      return {
        ok: false,
        error: `server process exited before becoming ready (see ${LOG_FILE})`,
      };
    }
    const detail = (e.stderr ?? "").trim() || e.message || "unknown error";
    return {
      ok: false,
      error: `server did not become ready within ${Math.round(timeoutMs / 1000)}s (${detail})`,
    };
  }
}

type DaemonAction = "start" | "stop" | "status" | "restart" | "rftoken";

type ParsedWebArgs = {
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

function defaultPort(): string {
  return process.env.PORT ?? DEFAULT_PORT;
}

function defaultHost(): string {
  return process.env.HOST ?? DEFAULT_HOST;
}

/** Parse port/host tokens shared by `pi --web ...` and `/web ...`. */
function parseWebOptions(
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
      if (!value || value.startsWith("-")) {
        return { error: `${arg} requires a value` };
      }
      token = value;
      continue;
    }

    if (arg.startsWith("--token=")) {
      const value = arg.slice("--token=".length);
      if (!value) return { error: "--token requires a value" };
      token = value;
      continue;
    }

    if (token === "--lan" || token === "--public" || token === "lan" || token === "public") {
      host = LAN_HOST;
      hostExplicit = true;
      continue;
    }

    if (token === "--host" || token === "-H" || token === "host") {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) {
        return { error: `${token} requires an address (e.g. 0.0.0.0)` };
      }
      host = value;
      hostExplicit = true;
      continue;
    }

    if (token.startsWith("--host=")) {
      const value = token.slice("--host=".length);
      if (!value) return { error: "--host requires an address (e.g. 0.0.0.0)" };
      host = value;
      hostExplicit = true;
      continue;
    }

    if (token.startsWith("-H=")) {
      const value = token.slice("-H=".length);
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

/** Parse `pi --web [stop|status|port] [--host <addr>|--lan]` from raw argv. */
function parseWebDaemonArgs(argv: string[] = process.argv): {
  enabled: boolean;
} & (ParsedWebArgs | { error: string }) {
  const idx = argv.findIndex((arg) => arg === "--web" || arg.startsWith("--web="));
  if (idx === -1) {
    return {
      enabled: false,
      action: "start",
      port: defaultPort(),
      host: defaultHost(),
    };
  }

  const tokens: string[] = [];

  // Allow --host/--lan/--restart/--token before --web; later tokens (after --web) override.
  for (let i = 0; i < idx; i++) {
    const arg = argv[i]!;
    if (arg === "--lan" || arg === "--public" || arg === "--restart") {
      tokens.push(arg);
      continue;
    }
    if (arg === "--host" || arg === "-H") {
      const value = argv[i + 1];
      if (value && !value.startsWith("-")) {
        tokens.push(arg, value);
        i++;
      } else {
        tokens.push(arg);
      }
      continue;
    }
    if (arg.startsWith("--host=") || arg.startsWith("-H=")) {
      tokens.push(arg);
      continue;
    }
    if (arg === "--token" || arg === "-t") {
      const value = argv[i + 1];
      if (value && !value.startsWith("-")) {
        tokens.push(arg, value);
        i++;
      } else {
        tokens.push(arg);
      }
      continue;
    }
    if (arg.startsWith("--token=")) {
      tokens.push(arg);
    }
  }

  const eq = argv[idx]!.startsWith("--web=") ? argv[idx]!.slice("--web=".length) : undefined;
  if (eq !== undefined && eq.length > 0) tokens.push(eq);

  for (let i = idx + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    // Stop at next top-level pi flag, but keep our own web flags.
    if (
      arg.startsWith("-") &&
      arg !== "--lan" &&
      arg !== "--public" &&
      arg !== "--restart" &&
      arg !== "--host" &&
      arg !== "-H" &&
      arg !== "--token" &&
      arg !== "-t" &&
      !arg.startsWith("--host=") &&
      !arg.startsWith("-H=") &&
      !arg.startsWith("--token=")
    ) {
      break;
    }
    tokens.push(arg);
  }

  const parsed = parseWebOptions(tokens);
  if ("error" in parsed) return { enabled: true, error: parsed.error };
  return { enabled: true, ...parsed };
}

/** Resolve port/host for start/restart, keeping previous bind on bare restart. */
function resolveLaunchTarget(parsed: ParsedWebArgs): { port: string; host: string } {
  const running = readPid() !== null;
  const prevPort = running ? readPort() : null;
  const prevHost = running ? readHost() : null;
  return {
    port: parsed.portExplicit ? parsed.port : (prevPort ?? parsed.port),
    host: parsed.hostExplicit ? parsed.host : (prevHost ?? parsed.host),
  };
}

function launchDaemon(
  port: string,
  host: string,
  opts: { openBrowser: boolean; verb: "started" | "restarted"; token?: string },
): void {
  const result = startServer(port, host, opts.token);
  if (!result.ok) {
    console.error(`pi-web-chat: ${result.error}`);
    process.exit(1);
  }

  const url = urlFor(result.port, result.host);
  const summary = describeServer(result.port, result.host, result.pid);

  if (result.already) {
    console.log(`pi-web-chat already running — ${summary}`);
    if (opts.openBrowser) openBrowser(url);
    process.exit(0);
  }

  process.stdout.write(`pi-web-chat starting (pid ${result.pid})…`);
  const ready = waitForServerReady(result.port, result.host, result.pid);
  if (!ready.ok) {
    process.stdout.write("\n");
    console.error(`pi-web-chat: ${ready.error}`);
    process.exit(1);
  }
  process.stdout.write(" ready\n");

  console.log(`pi-web-chat ${opts.verb} — ${summary}`);
  if (!isLoopbackHost(result.host)) {
    console.log(
      "  warning: bound beyond loopback — auth (token + 2FA) is enforced",
    );
  }
  console.log(`  stop:    pi --web stop`);
  console.log(`  restart: pi --web restart`);
  console.log(`  status:  pi --web status`);
  console.log(`  logs:    ${LOG_FILE}`);
  console.log(`  auth:    token & 2FA — see ${LOG_FILE} (or ~/.pi/web-chat/token)`);
  if (opts.openBrowser) openBrowser(url);
}

/** Rotate the access token: generate a new one and write it to the file
 * (a running server also picks it up from the next login on) */
function rotateToken(): string {
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

function handleRotateToken(ctx?: { ui: { notify: (msg: string, kind?: string) => void } }): void {
  const token = rotateToken();
  const msg = `pi-web-chat: access token rotated — ${token} (stored in ${TOKEN_FILE}, applies on next login)`;
  if (ctx) ctx.ui.notify(msg, "info");
  else console.log(msg);
}

function runDaemonAndExit(): void {
  const parsed = parseWebDaemonArgs();
  if ("error" in parsed) {
    console.error(`pi-web-chat: ${parsed.error}`);
    process.exit(1);
  }

  const { action } = parsed;

  if (action === "stop") {
    const { stopped, pid } = stopServer({ waitMs: 3_000 });
    console.log(stopped ? `pi-web-chat stopped (pid ${pid})` : "pi-web-chat is not running");
    process.exit(0);
  }

  if (action === "status") {
    const pid = readPid();
    if (pid === null) {
      console.log("pi-web-chat is not running");
      process.exit(1);
    }
    console.log(`pi-web-chat running — ${describeServer(readPort(), readHost(), pid)}`);
    process.exit(0);
  }

  if (action === "rftoken") {
    handleRotateToken();
    process.exit(0);
  }

  if (action === "restart") {
    const { port, host } = resolveLaunchTarget(parsed);
    const { stopped, pid } = stopServer({ waitMs: 5_000 });
    if (stopped) {
      console.log(`pi-web-chat stopped (pid ${pid})`);
    }
    launchDaemon(port, host, { openBrowser: true, verb: "restarted", token: parsed.token });
    process.exit(0);
  }

  // start
  const { port, host } = resolveLaunchTarget(parsed);
  launchDaemon(port, host, { openBrowser: true, verb: "started", token: parsed.token });
  // Detached server keeps running; do not open pi TUI.
  process.exit(0);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("web", {
    description:
      "Start pi-web-chat UI in background and exit (no TUI). Options: [port] [--host <addr>|--lan] [stop|status|restart|rftoken]",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("host", {
    description:
      "Bind address for pi-web-chat when used with --web (default 127.0.0.1; use 0.0.0.0 for LAN)",
    type: "string",
  });

  pi.registerFlag("lan", {
    description: "With --web, bind pi-web-chat to 0.0.0.0 (LAN access; token + 2FA auth)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("token", {
    description:
      "Access token for pi-web-chat when used with --web (default: auto-generated and stored in ~/.pi/web-chat/token)",
    type: "string",
  });

  pi.registerFlag("restart", {
    description: "With --web, stop the existing daemon (if any) and start a fresh one",
    type: "boolean",
    default: false,
  });

  // Handle --web as early as possible during extension load, before TUI starts.
  // getFlag() is not populated yet at factory time, so read argv directly.
  // waitForServerReady is synchronous so we exit only after the daemon is up.
  if (parseWebDaemonArgs().enabled) {
    runDaemonAndExit();
  }

  pi.registerCommand("web", {
    description:
      "pi-web-chat UI: /web [port] [--host <addr>|--lan] | /web stop | /web status | /web restart",
    handler: async (args, ctx) => {
      const tokens = args.trim() ? args.trim().split(/\s+/) : [];
      const parsed = parseWebOptions(tokens);
      if ("error" in parsed) {
        ctx.ui.notify(`pi-web-chat: ${parsed.error}`, "error");
        return;
      }

      const { action } = parsed;

      if (action === "stop") {
        const { stopped, pid } = stopServer({ waitMs: 3_000 });
        ctx.ui.notify(
          stopped ? `pi-web-chat stopped (pid ${pid})` : "pi-web-chat is not running",
          "info",
        );
        return;
      }

      if (action === "status") {
        const pid = readPid();
        if (pid === null) {
          ctx.ui.notify("pi-web-chat is not running", "info");
          return;
        }
        ctx.ui.notify(
          `pi-web-chat running — ${describeServer(readPort(), readHost(), pid)}`,
          "info",
        );
        return;
      }

      if (action === "rftoken") {
        handleRotateToken(ctx);
        return;
      }

      if (action === "restart") {
        const { port, host } = resolveLaunchTarget(parsed);
        const { stopped, pid } = stopServer({ waitMs: 5_000 });
        if (stopped) {
          ctx.ui.notify(`pi-web-chat stopped (pid ${pid})`, "info");
        }
        const result = startServer(port, host, parsed.token);
        if (!result.ok) {
          ctx.ui.notify(`pi-web-chat: ${result.error}`, "error");
          return;
        }
        ctx.ui.notify(`pi-web-chat starting (pid ${result.pid})…`, "info");
        const ready = waitForServerReady(result.port, result.host, result.pid);
        if (!ready.ok) {
          ctx.ui.notify(`pi-web-chat: ${ready.error}`, "error");
          return;
        }
        const summary = describeServer(result.port, result.host, result.pid);
        const warning = !isLoopbackHost(result.host)
          ? " — warning: non-loopback bind, auth enforced"
          : "";
        ctx.ui.notify(`pi-web-chat restarted — ${summary}${warning}`, "info");
        return;
      }

      // start
      const { port, host } = resolveLaunchTarget(parsed);
      const result = startServer(port, host, parsed.token);
      if (!result.ok) {
        ctx.ui.notify(`pi-web-chat: ${result.error}`, "error");
        return;
      }

      if (!result.already) {
        ctx.ui.notify(`pi-web-chat starting (pid ${result.pid})…`, "info");
        const ready = waitForServerReady(result.port, result.host, result.pid);
        if (!ready.ok) {
          ctx.ui.notify(`pi-web-chat: ${ready.error}`, "error");
          return;
        }
      }

      const summary = describeServer(result.port, result.host, result.pid);
      const warning =
        !result.already && !isLoopbackHost(result.host)
          ? " — warning: non-loopback bind, auth enforced"
          : "";
      ctx.ui.notify(
        result.already
          ? `pi-web-chat already running — ${summary}`
          : `pi-web-chat started — ${summary}${warning}`,
        "info",
      );
    },
  });
}
