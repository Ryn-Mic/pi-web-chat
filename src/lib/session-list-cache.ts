import type { UISessionInfo } from "../../shared/protocol";

const PREFIX = "pi-web-chat:session-list:";
export const SESSION_CACHE_SCOPE_KEY = "pi-web-chat:session-cache-scope";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHED_SESSIONS = 40;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function storage(): StorageLike | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function clearSessionListCache(target = storage()): void {
  if (!target) return;
  try {
    const keys = Array.from({ length: target.length }, (_, index) => target.key(index));
    for (const key of keys) if (key?.startsWith(PREFIX)) target.removeItem(key);
  } catch { /* Private browsing and quota restrictions must not break login. */ }
}

/** Only authenticated summary metadata is cached, with a random per-login scope. */
export function readSessionListCache(scope: string, now = Date.now(), target = storage()): UISessionInfo[] | undefined {
  if (!target || !scope) return;
  try {
    const raw = target.getItem(PREFIX + scope);
    if (!raw || raw.length > 400_000) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return;
    const { at, sessions } = value as { at?: unknown; sessions?: unknown };
    if (typeof at !== "number" || now - at > CACHE_TTL_MS || at > now + 60_000 || !Array.isArray(sessions)) {
      target.removeItem(PREFIX + scope);
      return;
    }
    if (sessions.length > MAX_CACHED_SESSIONS) return;
    if (!sessions.every((item) => item && typeof item === "object"
      && typeof item.id === "string" && typeof item.path === "string" && typeof item.project === "string"
      && typeof item.firstMessage === "string" && typeof item.modified === "string"
      && Number.isFinite(Date.parse(item.modified)) && typeof item.messageCount === "number"
      && (item.name === undefined || typeof item.name === "string")
      && (item.agent === undefined || item.agent === "pi" || item.agent === "codex"))) return;
    return sessions as UISessionInfo[];
  } catch { return; }
}

export function writeSessionListCache(scope: string, sessions: UISessionInfo[], now = Date.now(), target = storage()): void {
  if (!target || !scope) return;
  try {
    const summaries = sessions.slice(0, MAX_CACHED_SESSIONS).map((session) => ({
      id: session.id, path: session.path, project: session.project,
      ...(session.name ? { name: session.name.slice(0, 200) } : {}),
      firstMessage: session.firstMessage.slice(0, 200), modified: session.modified,
      messageCount: session.messageCount, ...(session.agent ? { agent: session.agent } : {}),
    }));
    target.setItem(PREFIX + scope, JSON.stringify({ at: now, sessions: summaries }));
  } catch { /* A full browser cache is optional, never a request failure. */ }
}
