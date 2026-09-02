/**
 * pi-web-chat extension
 *
 * - `pi --web`  → start UI server daemon and exit (no TUI)
 * - `/web`      → start | stop | status | <port> [--host <addr>|--lan] inside a normal pi session
 *
 * Daemon lifecycle lives in daemon-manager.ts so the standalone npm command
 * and this compatibility extension can manage the same server and state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LOG_FILE,
  TOKEN_FILE,
  defaultHost,
  defaultPort,
  describeServer,
  installedPackageVersion,
  isLoopbackHost,
  managedRestartPortError,
  openBrowser,
  parseWebOptions,
  readManagedServerStatus,
  resolveLaunchTarget,
  rotateToken,
  startServer,
  stopServer,
  urlFor,
  waitForServerReady,
  type ManagedServerStatus,
  type ParsedWebArgs,
} from "./daemon-manager.ts";

export { managedRestartPortError, parseWebOptions } from "./daemon-manager.ts";

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
      portExplicit: false,
      hostExplicit: false,
      token: undefined,
    };
  }

  const tokens: string[] = [];

  // Allow --host/--lan/--restart/--token before --web; later tokens override.
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
    if (arg.startsWith("--token=")) tokens.push(arg);
  }

  const eq = argv[idx]!.startsWith("--web=") ? argv[idx]!.slice("--web=".length) : undefined;
  if (eq !== undefined && eq.length > 0) tokens.push(eq);

  for (let i = idx + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    // Stop at the next top-level pi flag, but keep our own web flags.
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
  const ready = waitForServerReady(
    result.port,
    result.host,
    result.pid,
    result.instanceId,
  );
  if (!ready.ok) {
    process.stdout.write("\n");
    console.error(`pi-web-chat: ${ready.error}`);
    process.exit(1);
  }
  process.stdout.write(" ready\n");

  console.log(`pi-web-chat ${opts.verb} — ${summary}`);
  if (!isLoopbackHost(result.host)) {
    console.log("  warning: bound beyond loopback — auth (token + 2FA) is enforced");
  }
  console.log(`  stop:    pi --web stop`);
  console.log(`  restart: pi --web ${result.port} restart`);
  console.log(`  status:  pi --web status`);
  console.log(`  agents:  pi + Codex (select per new session in Web settings)`);
  console.log(`  logs:    ${LOG_FILE}`);
  console.log(`  auth:    token & 2FA — see ${LOG_FILE} (or ~/.pi/web-chat/token)`);
  if (opts.openBrowser) openBrowser(url);
}

function handleRotateToken(ctx?: {
  ui: { notify: (msg: string, kind?: "error" | "info" | "warning") => void };
}): void {
  const token = rotateToken();
  const message =
    `pi-web-chat: access token rotated — ${token} ` +
    `(stored in ${TOKEN_FILE}, applies on next login)`;
  if (ctx) ctx.ui.notify(message, "info");
  else console.log(message);
}

function daemonVersionWarning(status: ManagedServerStatus): string | null {
  const installedVersion = installedPackageVersion();
  if (status.version === null || status.version === installedVersion) return null;
  return (
    `version mismatch: running v${status.version}; installed v${installedVersion}\n` +
    `restart: pi-web-chat ${status.port} restart`
  );
}

function runDaemonAndExit(): void {
  const parsed = parseWebDaemonArgs();
  if ("error" in parsed) {
    console.error(`pi-web-chat: ${parsed.error}`);
    process.exit(1);
  }

  const { action } = parsed;
  const restartPortError = managedRestartPortError(action, parsed.portExplicit);
  if (restartPortError) {
    console.error(`pi-web-chat: ${restartPortError}`);
    process.exit(1);
  }

  if (action === "stop") {
    const result = stopServer({ waitMs: 3_000 });
    if (result.error) {
      console.error(`pi-web-chat: ${result.error}`);
      process.exit(1);
    }
    console.log(
      result.stopped
        ? `pi-web-chat stopped (pid ${result.pid})`
        : "pi-web-chat is not running",
    );
    process.exit(0);
  }

  if (action === "status") {
    const status = readManagedServerStatus();
    if (status === null) {
      console.log("pi-web-chat is not running");
      process.exit(1);
    }
    console.log(
      `pi-web-chat running — ${describeServer(status.port, status.host, status.pid)}`,
    );
    const warning = daemonVersionWarning(status);
    if (warning !== null) console.log(warning);
    process.exit(0);
  }

  if (action === "rftoken") {
    handleRotateToken();
    process.exit(0);
  }

  if (action === "restart") {
    const { port, host } = resolveLaunchTarget(parsed);
    const result = stopServer({ waitMs: 5_000 });
    if (result.error) {
      console.error(`pi-web-chat: ${result.error}`);
      process.exit(1);
    }
    if (result.stopped) console.log(`pi-web-chat stopped (pid ${result.pid})`);
    launchDaemon(port, host, {
      openBrowser: true,
      verb: "restarted",
      token: parsed.token,
    });
    process.exit(0);
  }

  const { port, host } = parsed;
  launchDaemon(port, host, {
    openBrowser: true,
    verb: "started",
    token: parsed.token,
  });
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

  // Handle --web before TUI startup. getFlag() is not populated at factory time.
  if (parseWebDaemonArgs().enabled) runDaemonAndExit();

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
        const result = stopServer({ waitMs: 3_000 });
        if (result.error) {
          ctx.ui.notify(`pi-web-chat: ${result.error}`, "error");
          return;
        }
        ctx.ui.notify(
          result.stopped
            ? `pi-web-chat stopped (pid ${result.pid})`
            : "pi-web-chat is not running",
          "info",
        );
        return;
      }

      if (action === "status") {
        const status = readManagedServerStatus();
        if (status === null) {
          ctx.ui.notify("pi-web-chat is not running", "info");
          return;
        }
        const warning = daemonVersionWarning(status);
        ctx.ui.notify(
          `pi-web-chat running — ${describeServer(status.port, status.host, status.pid)}` +
            (warning === null ? "" : `\n${warning}`),
          warning === null ? "info" : "warning",
        );
        return;
      }

      if (action === "rftoken") {
        handleRotateToken(ctx);
        return;
      }

      if (action === "restart") {
        const { port, host } = resolveLaunchTarget(parsed);
        const stopResult = stopServer({ waitMs: 5_000 });
        if (stopResult.error) {
          ctx.ui.notify(`pi-web-chat: ${stopResult.error}`, "error");
          return;
        }
        if (stopResult.stopped) {
          ctx.ui.notify(`pi-web-chat stopped (pid ${stopResult.pid})`, "info");
        }
        const startResult = startServer(port, host, parsed.token);
        if (!startResult.ok) {
          ctx.ui.notify(`pi-web-chat: ${startResult.error}`, "error");
          return;
        }
        if (!startResult.already) {
          ctx.ui.notify(`pi-web-chat starting (pid ${startResult.pid})…`, "info");
          const ready = waitForServerReady(
            startResult.port,
            startResult.host,
            startResult.pid,
            startResult.instanceId,
          );
          if (!ready.ok) {
            ctx.ui.notify(`pi-web-chat: ${ready.error}`, "error");
            return;
          }
        }
        const summary = describeServer(
          startResult.port,
          startResult.host,
          startResult.pid,
        );
        const warning = !isLoopbackHost(startResult.host)
          ? " — warning: non-loopback bind, auth enforced"
          : "";
        ctx.ui.notify(
          startResult.already
            ? `pi-web-chat already running — ${summary}`
            : `pi-web-chat restarted — ${summary}${warning}`,
          "info",
        );
        return;
      }

      const { port, host } = parsed;
      const result = startServer(port, host, parsed.token);
      if (!result.ok) {
        ctx.ui.notify(`pi-web-chat: ${result.error}`, "error");
        return;
      }

      if (!result.already) {
        ctx.ui.notify(`pi-web-chat starting (pid ${result.pid})…`, "info");
        const ready = waitForServerReady(
          result.port,
          result.host,
          result.pid,
          result.instanceId,
        );
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
