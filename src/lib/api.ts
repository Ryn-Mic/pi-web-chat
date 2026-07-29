import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  UICustomModelsResponse,
  UICustomProvider,
  UIExtensionsResponse,
  UIForkPoint,
  UIModel,
  UISessionInfo,
} from "../../shared/protocol";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
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

export function useForkPoints(enabled = true) {
  return useQuery({
    queryKey: ["fork-points"],
    queryFn: () => fetchJson<UIForkPoint[]>("/api/fork-points"),
    enabled,
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers }),
  });
  const json = (await res.json()) as UICustomModelsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `save failed: ${res.status}`);
  return json;
}

/** 모델 목록 재조회 (커스텀 모델 저장 후) */
export function useInvalidateModels() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["models"] });
}
