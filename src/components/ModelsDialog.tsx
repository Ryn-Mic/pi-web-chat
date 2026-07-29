import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import type { UICustomApi, UICustomModel, UICustomProvider } from "../../shared/protocol";
import { saveCustomModels, useCustomModels, useInvalidateModels } from "../lib/api";
import { useT } from "../lib/i18n";

const APIS: UICustomApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

const inputClass =
  "w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-faint";

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
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">
        {label}
        {hint && <span className="ml-1 font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function numberOrUndefined(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

function ModelRow({
  model,
  onChange,
  onRemove,
}: {
  model: UICustomModel;
  onChange: (next: UICustomModel) => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-line p-2.5">
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label={t("modelId")}>
            <input
              className={inputClass}
              value={model.id}
              placeholder="llama3.1:8b"
              onChange={(e) => onChange({ ...model, id: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field label={t("modelName")} hint={`(${t("optional")})`}>
            <input
              className={inputClass}
              value={model.name ?? ""}
              onChange={(e) => onChange({ ...model, name: e.target.value })}
            />
          </Field>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeModel")}
          title={t("removeModel")}
          className="mt-4 flex size-7 shrink-0 items-center justify-center self-start rounded-lg text-faint hover:bg-hover hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="w-32">
          <Field label={t("contextWindow")} hint={`(${t("optional")})`}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={model.contextWindow ?? ""}
              placeholder="128000"
              onChange={(e) => onChange({ ...model, contextWindow: numberOrUndefined(e.target.value) })}
            />
          </Field>
        </div>
        <div className="w-32">
          <Field label={t("maxTokens")} hint={`(${t("optional")})`}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={model.maxTokens ?? ""}
              placeholder="8192"
              onChange={(e) => onChange({ ...model, maxTokens: numberOrUndefined(e.target.value) })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-1.5 py-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            className="accent-[var(--c-accent)]"
            checked={model.reasoning ?? false}
            onChange={(e) => onChange({ ...model, reasoning: e.target.checked })}
          />
          {t("reasoning")}
        </label>
        <label className="flex items-center gap-1.5 py-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            className="accent-[var(--c-accent)]"
            checked={model.input?.includes("image") ?? false}
            onChange={(e) =>
              onChange({ ...model, input: e.target.checked ? ["text", "image"] : ["text"] })
            }
          />
          {t("imageInput")}
        </label>
      </div>
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
  const patch = (p: Partial<UICustomProvider>) => onChange({ ...provider, ...p });

  return (
    <div className="rounded-xl border border-line bg-canvas/60 p-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label={t("providerKey")}>
            <input
              className={inputClass}
              value={provider.key}
              placeholder="ollama"
              onChange={(e) => patch({ key: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-48">
          <Field label={t("apiType")}>
            <select
              className={inputClass}
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
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeProvider")}
          title={t("removeProvider")}
          className="mt-4 flex size-7 shrink-0 items-center justify-center self-start rounded-lg text-faint hover:bg-hover hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field label={t("baseUrl")}>
          <input
            className={inputClass}
            value={provider.baseUrl}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </Field>
        <Field label={t("apiKey")} hint={`(${t("optional")})`}>
          <input
            className={inputClass}
            value={provider.apiKey ?? ""}
            placeholder="$OPENAI_API_KEY"
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        </Field>
      </div>
      <p className="mt-1 text-[11px] text-faint">{t("apiKeyHint")}</p>

      <div className="mt-3 flex flex-col gap-2">
        {provider.models.map((m, i) => (
          <ModelRow
            key={i}
            model={m}
            onChange={(next) =>
              patch({ models: provider.models.map((old, j) => (j === i ? next : old)) })
            }
            onRemove={() => patch({ models: provider.models.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          type="button"
          onClick={() => patch({ models: [...provider.models, { id: "" }] })}
          className="self-start rounded-lg px-2 py-1 text-[12px] font-medium text-accent hover:bg-hover"
        >
          + {t("addModel")}
        </button>
      </div>
    </div>
  );
}

/** ~/.pi/agent/models.json 커스텀 프로바이더/모델 관리 */
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

  // 서버 데이터 → 편집 초안 (다이얼로그 열릴 때 1회)
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
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[82vh] w-[94vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-card shadow-xl outline-none">
          <div className="border-b border-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{t("manageModels")}</Dialog.Title>
            <Dialog.Description className="mt-0.5 font-mono text-xs text-faint">
              {t("customModelsDescription", { path: data?.path ?? "models.json" })}
            </Dialog.Description>
          </div>

          <div className="thin-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-4">
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
              <div className="py-6 text-center text-sm text-faint">{t("noCustomProviders")}</div>
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
              className="self-start rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-hover"
            >
              + {t("addProvider")}
            </button>
          </div>

          <div className="flex items-center gap-2 border-t border-line px-4 py-3">
            <div className="min-w-0 flex-1 truncate text-xs">
              {error ? (
                <span className="text-red-500 dark:text-red-400">{error}</span>
              ) : status === "saved" ? (
                <span className="text-emerald-600 dark:text-emerald-400">{t("saved")}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-ink"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={status === "saving" || draft === null}
              className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {status === "saving" ? t("saving") : t("save")}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
