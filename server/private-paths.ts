import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export function webChatStateDir(): string {
  const test = process.env.NODE_ENV === "test" ? process.env.PI_WEB_TEST_STATE_DIR?.trim() : undefined;
  return resolve(test || join(homedir(), ".pi", "web-chat"));
}

export function defaultChatWorkspace(): string { return join(webChatStateDir(), "workspace"); }

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** The workspace child is public; its private parent is never a file API root. */
export function isPrivateStatePath(path: string): boolean {
  const root = webChatStateDir();
  const blocked = (value: string, base: string) => within(value, base) && !within(value, join(base, "workspace"));
  return blocked(resolve(path), root) || blocked(canonical(path), canonical(root));
}

export class PrivateStatePathError extends Error {
  readonly code = "EACCES";
  constructor() { super("private application state"); }
}

export function assertPublicFilePath(path: string): void {
  if (isPrivateStatePath(path)) throw new PrivateStatePathError();
}

/** A hard link outside the private directory must not disclose a credential. */
export function assertPublicFileIdentity(st: { dev: number; ino: number }): void {
  for (const name of ["token", "2fa.secret", "sessions.json"]) {
    let privateStat;
    try { privateStat = statSync(join(webChatStateDir(), name)); } catch { continue; }
    if (privateStat.dev === st.dev && privateStat.ino === st.ino) throw new PrivateStatePathError();
  }
}
