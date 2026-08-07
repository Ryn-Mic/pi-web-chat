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
      apiKey: typeof p?.apiKey === "string" ? p.apiKey : undefined,
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

/** Merge-save models.json (preserves unknown fields, atomic write) */
export function writeCustomModels(providers: UICustomProvider[]): void {
  const { json } = readRaw();
  const prevProviders = (json.providers ?? {}) as Record<string, Json>;
  const nextProviders: Record<string, Json> = {};

  for (const p of providers) {
    const key = p.key.trim();
    const prev = prevProviders[key];
    const prevModels = Array.isArray(prev?.models) ? (prev.models as Json[]) : [];
    const entry: Json = { ...(prev ?? {}) };
    entry.baseUrl = p.baseUrl.trim();
    entry.api = p.api;
    if (p.apiKey?.trim()) entry.apiKey = p.apiKey.trim();
    else delete entry.apiKey;
    entry.models = p.models.map((m) =>
      mergeModel(
        prevModels.find((pm) => typeof pm?.id === "string" && pm.id === m.id.trim()),
        m,
      ),
    );
    nextProviders[key] = entry;
  }

  const out: Json = { ...json };
  if (Object.keys(nextProviders).length > 0) out.providers = nextProviders;
  else delete out.providers;

  const file = modelsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
