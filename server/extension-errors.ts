/**
 * Extension runtime errors surfaced by the pi SDK.
 *
 * The SDK catches every extension hook failure and hands it to
 * `bindExtensions({ onError })` as `ExtensionError`. Those failures are never
 * fatal to the run — the SDK skips the hook and keeps going — so the web UI
 * must neither report them as prompt failures nor hide which extension broke.
 * This module owns the naming/formatting and the log-once bookkeeping.
 */

export interface ExtensionErrorLike {
  /** Absolute path of the extension entry file that failed. */
  extensionPath: string;
  /** Hook name, e.g. `before_agent_start`. */
  event: string;
  /** Error message only; the stack is a separate field. */
  error: string;
  stack?: string;
}

/**
 * Derive a short display name from an extension file path, mirroring the
 * `/api/extensions` derivation but without `sourceInfo` (errors only carry a
 * path): `…/extensions/pi-cua-driver/index.ts` → `pi-cua-driver` and
 * `…/pi-claude-code-ui/extensions/index.ts` → `pi-claude-code-ui`.
 */
export function extensionNameFromPath(extensionPath: string): string {
  const segments = extensionPath.replace(/\.(ts|js|mjs|cjs)$/, "").split(/[\\/]/);
  const last = segments.at(-1) ?? extensionPath;
  if (last !== "index") return last;
  const parent = segments.at(-2);
  if (!parent) return last;
  return parent === "extensions" ? (segments.at(-3) ?? parent) : parent;
}

/** Shorten the agent-home prefix so messages stay readable in a banner. */
function shortenPath(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * One-line, self-describing report: which extension failed, in which hook, and
 * with what message plus the file to open when fixing it.
 */
export function describeExtensionError(error: ExtensionErrorLike, options: { home?: string } = {}): string {
  const name = extensionNameFromPath(error.extensionPath);
  const location = shortenPath(error.extensionPath, options.home ?? "");
  return `Extension error [${name} · ${error.event}]: ${error.error} (${location})`;
}

function extensionErrorKey(error: ExtensionErrorLike): string {
  return `${error.extensionPath}\u0000${error.event}\u0000${error.error}`;
}

export interface ExtensionErrorReport {
  /** True for the first occurrence of this exact failure in the session. */
  first: boolean;
  /** How many times this exact failure has been reported in the session. */
  count: number;
}

export interface ExtensionErrorReporterOptions {
  log: (line: string) => void;
  /** Emit a compact repeat line every N occurrences. Default 50. */
  repeatEvery?: number;
}

/**
 * Build a per-session reporter. A broken hook can fire on every streaming
 * delta, so only the first occurrence logs a stack; repeats collapse into a
 * periodic counter instead of flooding the daemon log.
 */
export function createExtensionErrorReporter(
  options: ExtensionErrorReporterOptions,
): (error: ExtensionErrorLike) => ExtensionErrorReport {
  const counts = new Map<string, number>();
  const repeatEvery = options.repeatEvery ?? 50;
  return (error) => {
    const key = extensionErrorKey(error);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count === 1) {
      options.log(
        `pi-web-chat extension error: ${describeExtensionError(error)}${error.stack ? `\n${error.stack}` : ""}`,
      );
    } else if (count % repeatEvery === 0) {
      options.log(`pi-web-chat extension error (x${count}): ${describeExtensionError(error)}`);
    }
    return { first: count === 1, count };
  };
}
