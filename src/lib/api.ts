import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  UICustomModelsResponse,
  UICustomProvider,
  UIModelDiscoveryRequest,
  UIModelDiscoveryResponse,
  UIExtensionsResponse,
  UIFileSearchResponse,
  UIForkPoint,
  UIModel,
  UISessionInfo,
  UITreeResponse,
} from "../../shared/protocol";
import { authHeaders, setAuthStatus } from "./auth";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  if (res.status === 401) {
    // Expired/invalid session → login screen
    setAuthStatus("unauthenticated");
    throw new Error(`${url}: 401 unauthorized`);
  }
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const SESSIONS_QUERY_KEY = ["sessions"] as const;

export function useSessions(enabled = true) {
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => fetchJson<UISessionInfo[]>("/api/sessions"),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

/** Refresh the sidebar list after session create/switch/message completion */
export function useInvalidateSessions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
}

export function useTree(cwd: string | undefined, path: string, enabled = true) {
  return useQuery({
    queryKey: ["tree", cwd, path],
    queryFn: () =>
      fetchJson<UITreeResponse>(
        `/api/tree?cwd=${encodeURIComponent(cwd ?? "")}&path=${encodeURIComponent(path)}`,
      ),
    enabled: enabled && !!cwd,
    staleTime: 0,
  });
}

export function useFileSearch(cwd: string | undefined, query: string, enabled = true) {
  return useQuery({
    queryKey: ["file-search", cwd, query],
    queryFn: () =>
      fetchJson<UIFileSearchResponse>(
        `/api/files/search?cwd=${encodeURIComponent(cwd ?? "")}&q=${encodeURIComponent(query)}`,
      ),
    enabled: enabled && !!cwd,
    staleTime: 2_000,
    // Keep previous results while the next keystroke's request is in flight
    placeholderData: (prev) => prev,
  });
}

/** Refresh every fetched level of a project's tree (refresh button) */
export function useInvalidateTree() {
  const qc = useQueryClient();
  return (cwd: string) => qc.invalidateQueries({ queryKey: ["tree", cwd] });
}

/** Delete a session (removes the file) */
export async function deleteSession(id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Set a session display name (empty string clears it) */
export async function renameSession(id: string, name: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/name`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function useForkPoints(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["fork-points", sessionId],
    queryFn: () =>
      fetchJson<UIForkPoint[]>(`/api/fork-points?session=${encodeURIComponent(sessionId ?? "")}`),
    enabled: enabled && !!sessionId,
    staleTime: 0,
  });
}

export function useExtensions(enabled = true) {
  return useQuery({
    queryKey: ["extensions"],
    queryFn: () => fetchJson<UIExtensionsResponse>("/api/extensions"),
    enabled,
    staleTime: 0,
  });
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => fetchJson<UIModel[]>("/api/models"),
    staleTime: 5 * 60_000,
  });
}

export const CUSTOM_MODELS_QUERY_KEY = ["custom-models"] as const;

/** Custom providers/models from ~/.pi/agent/models.json */
export function useCustomModels(enabled = true) {
  return useQuery({
    queryKey: CUSTOM_MODELS_QUERY_KEY,
    queryFn: () => fetchJson<UICustomModelsResponse>("/api/custom-models"),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export async function discoverCustomModels(
  provider: UIModelDiscoveryRequest,
): Promise<UIModelDiscoveryResponse> {
  const res = await fetch("/api/custom-models/discover", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(provider),
  });
  if (res.status === 401) setAuthStatus("unauthenticated");
  const json = (await res.json()) as UIModelDiscoveryResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `model discovery failed: ${res.status}`);
  return json;
}

export async function saveCustomModels(
  providers: UICustomProvider[],
): Promise<UICustomModelsResponse> {
  const res = await fetch("/api/custom-models", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ providers }),
  });
  if (res.status === 401) setAuthStatus("unauthenticated");
  const json = (await res.json()) as UICustomModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `save failed: ${res.status}`);
  return json;
}

/** Re-fetch the model list (after saving custom models) */
export function useInvalidateModels() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["models"] });
}
