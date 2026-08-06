import { useSyncExternalStore } from "react";

export type AuthStatus = "checking" | "authenticated" | "unauthenticated";

const TOKEN_KEY = "pi-web-chat:session-token";
const listeners = new Set<() => void>();

let status: AuthStatus = "checking";

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let cachedToken: string | null =
  typeof window !== "undefined" ? readStoredToken() : null;

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSessionToken(): string | null {
  return cachedToken;
}

export function setSessionToken(token: string | null) {
  cachedToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

export function getAuthStatus(): AuthStatus {
  return status;
}

export function setAuthStatus(next: AuthStatus) {
  if (status === next) return;
  status = next;
  emit();
}

export function useAuthStatus(): AuthStatus {
  return useSyncExternalStore(subscribe, getAuthStatus, () => "checking");
}

export function authHeaders(): Record<string, string> {
  const t = cachedToken;
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** Check the session token at boot */
export async function checkAuth(): Promise<AuthStatus> {
  try {
    const res = await fetch("/api/auth/status", { headers: authHeaders() });
    const next: AuthStatus = res.ok ? "authenticated" : "unauthenticated";
    setAuthStatus(next);
    return next;
  } catch {
    // Server unreachable — stay on checking (AuthGate handles retries)
    return "checking";
  }
}

/** Login: token + (TOTP code when 2FA is on) */
export async function login(token: string, totp?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, totp }),
    });
    const json = (await res.json().catch(() => ({}))) as { sessionToken?: string; error?: string };
    if (!res.ok || !json.sessionToken) {
      return { ok: false, error: json.error ?? `login failed (${res.status})` };
    }
    setSessionToken(json.sessionToken);
    setAuthStatus("authenticated");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function logout() {
  const token = cachedToken;
  setSessionToken(null);
  setAuthStatus("unauthenticated");
  if (token) {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: authHeaders(),
      });
    } catch {
      /* ignore */
    }
  }
}
