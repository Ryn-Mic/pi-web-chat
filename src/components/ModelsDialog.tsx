import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useRef, useState } from "react";
import type { UICustomApi, UICustomModel, UICustomProvider, UIThinkingLevel } from "../../shared/protocol";
import {
  discoverCustomModels,
  saveCustomModels,
  useCustomModels,
  useInvalidateModels,
} from "../lib/api";
import { useT } from "../lib/i18n";

const APIS: UICustomApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

const inputClass =
  "h-9 w-full rounded-lg border border-line bg-canvas/70 px-2.5 text-[13px] text-ink outline-none placeholder:text-faint transition-[border-color,box-shadow] focus:border-accent/60 focus:ring-2 focus:ring-accent/10";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-wide text-faint">
        {label}
        {hint && <span className="ml-1 font-normal tracking-normal text-faint/80">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.5]" aria-hidden>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" strokeLinecap="round" strokeWidth="2.5" />
      <path d="M11 7h6M11 17h6" strokeLinecap="round" />
    </svg>
  );
}

function ModelIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.5]" aria-hidden>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" strokeLinejoin="round" />
      <path d="m4.5 7.5 7.5 4.25 7.5-4.25M12 12v9" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.5]" aria-hidden>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-3.5 fill-none stroke-current stroke-2 transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.7]" aria-hidden>
      <path d="M20 11a8 8 0 0 0-14.7-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14.7 4L20 15m0 4v-4h-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function numberOrUndefined(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

/** 全部可选思考强度 (与服务端 ALL_THINKING_LEVELS 一致) */
const THINKING_LEVELS: UIThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * 镜像服务端 supportedThinkingLevels: thinkingLevelMap 中显式 null = 不支持;
 * xhigh/max 需要显式映射才可用; 其余等级默认支持。
 */
function isLevelSupported(model: UICustomModel, level: UIThinkingLevel): boolean {
  const map = model.thinkingLevelMap;
  if (map?.[level] === null) return false;
  if ((level === "xhigh" || level === "max") && map?.[level] == null) return false;
  return true;
}

/**
 * 多选切换某个思考强度。选中 -> 写入映射 (保留已有的 provider 原生名);
 * 取消 -> 显式写 null (否则缺省等级会被当作默认支持)。
 */
function toggleThinkingLevel(
  model: UICustomModel,
  level: UIThinkingLevel,
  checked: boolean,
): UICustomModel {
  const map = { ...model.thinkingLevelMap };
  if (checked) map[level] = map[level] ?? level;
  else map[level] = null;
  return { ...model, thinkingLevelMap: Object.keys(map).length > 0 ? map : undefined };
}

function ModelPicker({
  value,
  providerName,
  options,
  discovered,
  discovering,
  onChange,
  onDiscover,
}: {
  value: string;
  providerName: string;
  options: string[];
  discovered: boolean;
  discovering: boolean;
  onChange: (value: string) => void;
  onDiscover: () => Promise<void>;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sortedOptions = [...new Set(options)].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [menuOpen]);

  const toggleMenu = () => {
    setMenuOpen((open) => !open);
    if (!menuOpen && !discovered && !discovering) void onDiscover();
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex min-w-0">
        <input
          className={`${inputClass} min-w-0 rounded-r-none border-r-0 font-mono`}
          value={value}
          placeholder="llama3.1:8b"
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={toggleMenu}
          aria-label={t("chooseModel")}
          title={t("chooseModel")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-r-lg border border-line bg-canvas/70 text-faint transition-colors hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
          disabled={discovering}
        >
          <ChevronIcon open={menuOpen} />
        </button>
      </div>
      {menuOpen && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-card p-1 shadow-[0_10px_30px_rgba(0,0,0,0.14)]">
          {discovering ? (
            <div className="px-2 py-2 text-[11px] text-faint">{t("discoveringModels")}</div>
          ) : sortedOptions.length > 0 ? (
            sortedOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setMenuOpen(false);
                }}
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{option}</span>
                <span className="max-w-[42%] shrink-0 truncate text-right text-[10px] text-faint">
                  {providerName || "—"}
                </span>
              </button>
            ))
          ) : (
            <div className="px-2 py-2 text-[11px] text-faint">{t("noModelsFound")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelRow({
  model,
  index,
  providerName,
  availableModels,
  discovered,
  discovering,
  onDiscover,
  onChange,
  onRemove,
}: {
  model: UICustomModel;
  index: number;
  providerName: string;
  availableModels: string[];
  discovered: boolean;
  discovering: boolean;
  onDiscover: () => Promise<void>;
  onChange: (next: UICustomModel) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(model.id.trim() === "");
  const modelLabel = model.name?.trim() || model.id || t("newModel");
  const hasImage = model.input?.includes("image");

  return (
    <div
      className={`rounded-xl border border-line/80 bg-card/70 transition-colors hover:border-faint/70 ${
        expanded ? "p-2.5" : "px-2 py-1.5"
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-[12px] text-muted hover:text-ink"
        >
          <ChevronIcon open={expanded} />
          <span className="flex size-5 shrink-0 items-center justify-center rounded bg-accent-soft font-mono text-[9px] font-semibold text-accent">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{modelLabel}</span>
          {model.reasoning && (
            <span className="hidden shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent sm:inline">
              {t("reasoning")}
            </span>
          )}
          {hasImage && (
            <span className="hidden shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-faint sm:inline">
              {t("imageInput")}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeModel")}
          title={t("removeModel")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
        >
          <TrashIcon />
        </button>
      </div>

      {expanded && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_8rem_7rem]">
            <Field label={t("modelId")}>
              <ModelPicker
                value={model.id}
                providerName={providerName}
                options={availableModels}
                discovered={discovered}
                discovering={discovering}
                onDiscover={onDiscover}
                onChange={(id) => onChange({ ...model, id })}
              />
            </Field>
            <Field label={t("modelName")} hint={`(${t("optional")})`}>
              <input
                className={inputClass}
                value={model.name ?? ""}
                placeholder={model.id || t("modelName")}
                onChange={(e) => onChange({ ...model, name: e.target.value })}
              />
            </Field>
            <Field label={t("contextWindow")} hint={`(${t("optional")})`}>
              <input
                className={`${inputClass} font-mono tabular-nums`}
                inputMode="numeric"
                value={model.contextWindow ?? ""}
                placeholder="128000"
                onChange={(e) => onChange({ ...model, contextWindow: numberOrUndefined(e.target.value) })}
              />
            </Field>
            <Field label={t("maxTokens")} hint={`(${t("optional")})`}>
              <input
                className={`${inputClass} font-mono tabular-nums`}
                inputMode="numeric"
                value={model.maxTokens ?? ""}
                placeholder="8192"
                onChange={(e) => onChange({ ...model, maxTokens: numberOrUndefined(e.target.value) })}
              />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line/70 pt-2">
            <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-lg border border-line px-2 text-[12px] text-muted transition-colors hover:border-faint hover:bg-hover has-[:checked]:border-accent/50 has-[:checked]:bg-accent-soft/50 has-[:checked]:text-ink">
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--c-accent)]"
                checked={model.reasoning ?? false}
                onChange={(e) => onChange({ ...model, reasoning: e.target.checked })}
              />
              {t("reasoning")}
            </label>
            <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-lg border border-line px-2 text-[12px] text-muted transition-colors hover:border-faint hover:bg-hover has-[:checked]:border-accent/50 has-[:checked]:bg-accent-soft/50 has-[:checked]:text-ink">
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--c-accent)]"
                checked={hasImage}
                onChange={(e) =>
                  onChange({ ...model, input: e.target.checked ? ["text", "image"] : ["text"] })
                }
              />
              {t("imageInput")}
            </label>
          </div>
          {model.reasoning && (
            <div className="mt-2 rounded-lg bg-hover/50 p-2">
              <Field label={t("thinkingLevels")} hint={`(${t("optional")})`}>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {THINKING_LEVELS.map((level) => {
                    const checked = isLevelSupported(model, level);
                    return (
                      <label
                        key={level}
                        className={`flex cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                          checked
                            ? "border-accent/60 bg-accent-soft text-ink"
                            : "border-line bg-card/40 text-faint hover:border-faint hover:text-muted"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="size-3 accent-[var(--c-accent)]"
                          checked={checked}
                          onChange={(e) => {
                            const next = toggleThinkingLevel(model, level, e.target.checked);
                            if (
                              !e.target.checked &&
                              THINKING_LEVELS.every((l) => !isLevelSupported(next, l))
                            ) {
                              return;
                            }
                            onChange(next);
                          }}
                        />
                        {level}
                      </label>
                    );
                  })}
                </div>
              </Field>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  onChange,
  onRemove,
}: {
  provider: UICustomProvider;
  onChange: (next: UICustomProvider) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const patch = (p: Partial<UICustomProvider>) => onChange({ ...provider, ...p });

  useEffect(() => {
    setAvailableModels([]);
    setDiscovered(false);
    setDiscoveryError(null);
  }, [provider.baseUrl, provider.api, provider.apiKey]);

  const discoverModels = async () => {
    if (discovering) return;
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const result = await discoverCustomModels({
        key: provider.key,
        baseUrl: provider.baseUrl,
        api: provider.api,
        apiKey: provider.apiKey,
      });
      setAvailableModels(result.models);
      setDiscovered(true);
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };
  const modelOptions = [
    ...new Set([
      ...provider.models.map((model) => model.id.trim()).filter(Boolean),
      ...availableModels,
    ]),
  ];

  return (
    <div className="rounded-2xl border border-line bg-canvas/45 p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] sm:p-3">
      <div className="flex items-start gap-2">
        <div className="mt-4 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <ServerIcon />
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 lg:grid-cols-[minmax(0,1fr)_11rem_minmax(0,1.35fr)_minmax(0,1fr)]">
          <Field label={t("providerKey")}>
            <input
              className={`${inputClass} font-mono`}
              value={provider.key}
              placeholder="ollama"
              onChange={(e) => patch({ key: e.target.value })}
            />
          </Field>
          <Field label={t("apiType")}>
            <select
              className={`${inputClass} cursor-pointer`}
              value={provider.api}
              onChange={(e) => patch({ api: e.target.value as UICustomApi })}
            >
              {APIS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("baseUrl")}>
            <input
              className={`${inputClass} font-mono`}
              value={provider.baseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </Field>
          <Field label={t("apiKey")} hint={`(${t("optional")})`}>
            <div className="relative">
              <input
                type="text"
                className={`${inputClass} font-mono`}
                value={provider.apiKey ?? ""}
                placeholder="$OPENAI_API_KEY"
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
            </div>
          </Field>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeProvider")}
          title={t("removeProvider")}
          className="mt-4 flex size-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
        >
          <TrashIcon />
        </button>
      </div>
      <p className="mt-1 pl-0.5 text-[11px] leading-relaxed text-faint">{t("apiKeyHint")}</p>

      <div className="mt-3 border-t border-line/70 pt-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
          <ModelIcon />
          <span>{t("models")}</span>
          <span className="font-normal normal-case tracking-normal text-faint/70">· {provider.models.length}</span>
          <button
            type="button"
            onClick={() => void discoverModels()}
            disabled={discovering}
            aria-label={t("discoverModels")}
            title={t("discoverModels")}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium normal-case tracking-normal text-accent transition-colors hover:bg-accent-soft/60 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshIcon />
            <span className="hidden sm:inline">{discovering ? t("discoveringModels") : t("discoverModels")}</span>
          </button>
        </div>
        {discoveryError && <p className="mb-1.5 text-[11px] leading-relaxed text-red-500">{discoveryError}</p>}
        <div className="ml-1 flex flex-col gap-1.5 border-l border-accent/30 pl-2 sm:ml-2 sm:pl-3">
          {provider.models.map((m, i) => (
            <ModelRow
              key={i}
              index={i}
              model={m}
              providerName={provider.key}
              availableModels={modelOptions}
              discovered={discovered}
              discovering={discovering}
              onDiscover={discoverModels}
              onChange={(next) =>
                patch({ models: provider.models.map((old, j) => (j === i ? next : old)) })
              }
              onRemove={() => patch({ models: provider.models.filter((_, j) => j !== i) })}
            />
          ))}
          <button
            type="button"
            onClick={() => patch({ models: [...provider.models, { id: "" }] })}
            className="flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
          >
            <PlusIcon />
            {t("addModel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Manage custom providers/models in ~/.pi/agent/models.json */
export function ModelsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { data, refetch } = useCustomModels(open);
  const invalidateModels = useInvalidateModels();
  const [draft, setDraft] = useState<UICustomProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  // Server data → edit draft (once when the dialog opens)
  useEffect(() => {
    if (open && data && draft === null) setDraft(structuredClone(data.providers));
  }, [open, data, draft]);

  const close = () => {
    onOpenChange(false);
    setDraft(null);
    setError(null);
    setStatus("idle");
  };

  const save = async () => {
    if (!draft) return;
    setStatus("saving");
    setError(null);
    try {
      const result = await saveCustomModels(draft);
      setDraft(structuredClone(result.providers));
      setStatus("saved");
      setError(result.warning ?? null);
      await invalidateModels();
      await refetch();
      if (!result.warning) window.setTimeout(close, 400);
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed top-[max(1rem,env(safe-area-inset-top))] bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex w-[min(94vw,52rem)] translate-x-[-50%] translate-y-0 flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-[0_18px_60px_rgba(0,0,0,0.16)] outline-none sm:top-1/2 sm:bottom-auto sm:max-h-[88vh] sm:-translate-y-1/2">
          <div className="flex items-start gap-2.5 border-b border-line px-3 py-2.5 sm:px-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <ModelIcon />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-semibold tracking-tight">{t("manageModels")}</Dialog.Title>
              <Dialog.Description
                className="mt-1 truncate font-mono text-[11px] text-faint"
                title={data?.path ?? "models.json"}
              >
                {t("customModelsDescription", { path: data?.path ?? "models.json" })}
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={t("cancel")}
              title={t("cancel")}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
            >
              <CloseIcon />
            </button>
          </div>

          <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 sm:p-3">
            {data?.parseError && (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                models.json parse error: {data.parseError}
              </div>
            )}
            {(draft ?? []).map((p, i) => (
              <ProviderCard
                key={i}
                provider={p}
                onChange={(next) =>
                  setDraft((prev) => (prev ?? []).map((old, j) => (j === i ? next : old)))
                }
                onRemove={() => setDraft((prev) => (prev ?? []).filter((_, j) => j !== i))}
              />
            ))}
            {draft && draft.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-4 py-7 text-center">
                <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-hover text-faint">
                  <ServerIcon />
                </div>
                <p className="text-sm font-medium text-muted">{t("noCustomProviders")}</p>
                <p className="mt-1 max-w-xs text-xs leading-relaxed text-faint">{t("customModelsDescription", { path: data?.path ?? "models.json" })}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() =>
                setDraft((prev) => [
                  ...(prev ?? []),
                  {
                    key: "",
                    baseUrl: "",
                    api: "openai-completions",
                    apiKey: "",
                    models: [{ id: "" }],
                  },
                ])
              }
              className="flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
            >
              <PlusIcon />
              {t("addProvider")}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-card px-3 py-2.5 sm:px-4">
            <div className="min-w-0 flex-1 truncate text-xs">
              {error ? (
                <span className="text-red-500 dark:text-red-400">{error}</span>
              ) : status === "saved" ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                  {t("saved")}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-3 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={status === "saving" || draft === null}
              className="min-w-20 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "saving" ? t("saving") : t("save")}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
