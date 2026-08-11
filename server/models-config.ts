/**
 * Read/write ~/.pi/agent/models.json (custom providers/models).
 *
 * Fields the edit UI doesn't touch (cost, compat, headers, etc.) are preserved
 * via merge.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  UICustomApi,
  UICustomModel,
  UICustomModelsResponse,
  UICustomProvider,
  UIThinkingLevel,
} from "../shared/protocol.ts";

const HOME = homedir();

const APIS: UICustomApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

const THINKING_LEVELS: UIThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function modelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function shorten(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

type Json = Record<string, unknown>;

function readRaw(): { json: Json; parseError?: string } {
  const file = modelsPath();
  if (!existsSync(file)) return { json: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { json: {}, parseError: "models.json is not a JSON object" };
    }
    return { json: parsed as Json };
  } catch (err) {
    return { json: {}, parseError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Mask a stored apiKey for UI display: first 4 + "…" + last 4 chars.
 * - $ENV_VAR references are returned as-is (they are not secrets)
 * - Keys shorter than 9 chars are masked entirely (first4+last4 would overlap)
 */
export function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const k = key.trim();
  if (k.startsWith("$")) return k;
  if (k.length <= 8) return "••••••••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/**
 * Resolve an apiKey received from the UI for internal use (discovery):
 * when the incoming value is the masked form of a stored key, restore the
 * real key; otherwise treat it as a new value (or $ENV_VAR reference).
 * A masked value that matches nothing is rejected — it can only mean a
 * stale mask (e.g. after renaming the provider key) and would be useless
 * (or worse, a non-ASCII header) downstream.
 */
export function resolveIncomingApiKey(
  providerKey: string,
  incoming: string | undefined,
): string | undefined {
  const key = incoming?.trim();
  if (!key) return undefined;
  const { json } = readRaw();
  const providers = (json.providers ?? {}) as Record<string, Json>;
  const stored = providers[providerKey]?.apiKey;
  if (typeof stored === "string" && key === maskApiKey(stored)) return stored;
  if (isMaskedValue(key)) {
    throw new Error(
      `apiKey for "${providerKey}" is masked but does not match the stored key — re-enter the key`,
    );
  }
  return key;
}

/** The mask marker used by maskApiKey — its presence means a masked value. */
function isMaskedValue(value: string): boolean {
  return value.includes("…");
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toThinkingLevelMap(
  value: unknown,
): Partial<Record<UIThinkingLevel, string | null>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    ([level, mapped]) =>
      THINKING_LEVELS.includes(level as UIThinkingLevel) &&
      (typeof mapped === "string" || mapped === null),
  );
  return entries.length > 0
    ? (Object.fromEntries(entries) as Partial<Record<UIThinkingLevel, string | null>>)
    : undefined;
}

export function readCustomModels(): UICustomModelsResponse {
  const { json, parseError } = readRaw();
  const providersRaw = (json.providers ?? {}) as Record<string, Json>;
  const providers: UICustomProvider[] = Object.entries(providersRaw).map(([key, p]) => {
    const models = Array.isArray(p?.models) ? (p.models as Json[]) : [];
    return {
      key,
      baseUrl: typeof p?.baseUrl === "string" ? p.baseUrl : "",
      api: (APIS.includes(p?.api as UICustomApi) ? p.api : "openai-completions") as UICustomApi,
      apiKey: maskApiKey(typeof p?.apiKey === "string" ? p.apiKey : undefined),
      models: models
        .filter((m): m is Json => !!m && typeof m === "object")
        .map((m) => ({
          id: typeof m.id === "string" ? m.id : "",
          name: typeof m.name === "string" ? m.name : undefined,
          reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
          contextWindow: toNumber(m.contextWindow),
          maxTokens: toNumber(m.maxTokens),
          input: Array.isArray(m.input)
            ? (m.input.filter((i) => i === "text" || i === "image") as ("text" | "image")[])
            : undefined,
          thinkingLevelMap: toThinkingLevelMap(m.thinkingLevelMap),
        })),
    };
  });
  return { path: shorten(modelsPath()), providers, parseError };
}

/** Validate user input. Returns a message when there's a problem. */
export function validateProviders(providers: unknown): string | null {
  if (!Array.isArray(providers)) return "providers must be an array";
  const seen = new Set<string>();
  for (const p of providers as UICustomProvider[]) {
    if (!p || typeof p !== "object") return "invalid provider entry";
    const key = String(p.key ?? "").trim();
    if (!key) return "provider key is required";
    if (!/^[\w.-]+$/.test(key)) return `invalid provider key: ${key}`;
    if (seen.has(key)) return `duplicate provider key: ${key}`;
    seen.add(key);
    if (!APIS.includes(p.api)) return `invalid api for ${key}`;
    const baseUrl = String(p.baseUrl ?? "").trim();
    if (!baseUrl) return `baseUrl is required for ${key}`;
    if (!/^https?:\/\//.test(baseUrl)) return `baseUrl must start with http(s):// (${key})`;
    if (!Array.isArray(p.models) || p.models.length === 0) {
      return `at least one model is required for ${key}`;
    }
    const ids = new Set<string>();
    for (const m of p.models) {
      const id = String(m?.id ?? "").trim();
      if (!id) return `model id is required for ${key}`;
      if (ids.has(id)) return `duplicate model id in ${key}: ${id}`;
      ids.add(id);
      for (const field of ["contextWindow", "maxTokens"] as const) {
        const v = m[field];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
          return `${field} must be a positive number (${key}/${id})`;
        }
      }
    }
  }
  return null;
}

function mergeModel(existing: Json | undefined, next: UICustomModel): Json {
  const out: Json = { ...(existing ?? {}) };
  out.id = next.id.trim();
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === "" || v === null) delete out[k];
    else out[k] = v;
  };
  put("name", next.name?.trim());
  put("reasoning", next.reasoning);
  put("contextWindow", next.contextWindow);
  put("maxTokens", next.maxTokens);
  put("input", next.input && next.input.length > 0 ? next.input : undefined);
  put("thinkingLevelMap", next.thinkingLevelMap);
  return out;
}

/**
 * Merge-save models.json (preserves unknown fields, atomic write).
 *
 * A masked apiKey (as returned by readCustomModels) is detected and the
 * stored real key is preserved — the UI never overwrites it with the mask.
 *
 * Returns the resolved providers (with real keys) so callers can register
 * them into runtimes / use them for live reload.
 */
export function writeCustomModels(providers: UICustomProvider[]): UICustomProvider[] {
  const { json } = readRaw();
  const prevProviders = (json.providers ?? {}) as Record<string, Json>;
  const nextProviders: Record<string, Json> = {};
  const resolved: UICustomProvider[] = [];

  for (const p of providers) {
    const key = p.key.trim();
    const prev = prevProviders[key];
    const prevModels = Array.isArray(prev?.models) ? (prev.models as Json[]) : [];
    const entry: Json = { ...(prev ?? {}) };
    entry.baseUrl = p.baseUrl.trim();
    entry.api = p.api;
    const incoming = p.apiKey?.trim();
    const stored = typeof prev?.apiKey === "string" ? (prev.apiKey as string) : undefined;
    let apiKey: string | undefined;
    if (incoming && stored && incoming === maskApiKey(stored)) {
      apiKey = stored; // masked value unchanged → keep the real key
    } else if (incoming && isMaskedValue(incoming)) {
      // A stale mask (e.g. provider renamed) must not be persisted as a key.
      throw new Error(
        `apiKey for "${key}" is masked but does not match the stored key — re-enter the key or rename the provider back`,
      );
    } else if (incoming) {
      apiKey = incoming;
    }
    if (apiKey) entry.apiKey = apiKey;
    else delete entry.apiKey;
    entry.models = p.models.map((m) =>
      mergeModel(
        prevModels.find((pm) => typeof pm?.id === "string" && pm.id === m.id.trim()),
        m,
      ),
    );
    nextProviders[key] = entry;
    resolved.push({ key, baseUrl: p.baseUrl.trim(), api: p.api, apiKey, models: p.models });
  }

  const out: Json = { ...json };
  if (Object.keys(nextProviders).length > 0) out.providers = nextProviders;
  else delete out.providers;

  const file = modelsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return resolved;
}
