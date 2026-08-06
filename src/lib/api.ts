import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  UICustomModelsResponse,
  UICustomProvider,
  UIExtensionsResponse,
  UIForkPoint,
  UIModel,
  UISessionInfo,
} from "../../shared/protocol";
import { authHeaders, setAuthStatus } from "./auth";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  if (res.status === 401) {
    // 세션 만료/무효 → 로그인 화면으로
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

/** 세션 생성/전환/메시지 완료 후 사이드바 목록 갱신 */
export function useInvalidateSessions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
}

/** 세션 삭제 (파일 제거) */
export async function deleteSession(id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 세션 표시 이름 변경 (빈 문자열이면 해제) */
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

/** ~/.pi/agent/models.json 의 커스텀 프로바이더/모델 */
export function useCustomModels(enabled = true) {
  return useQuery({
    queryKey: CUSTOM_MODELS_QUERY_KEY,
    queryFn: () => fetchJson<UICustomModelsResponse>("/api/custom-models"),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
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

/** 모델 목록 재조회 (커스텀 모델 저장 후) */
export function useInvalidateModels() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["models"] });
}
