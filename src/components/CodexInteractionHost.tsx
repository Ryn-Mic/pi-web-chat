import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useMemo, useState } from "react";
import type {
  UICodexInteraction,
  UICodexInteractionResponse,
} from "../../shared/protocol";
import { chatClient, useChat } from "../lib/chat";
import { useT } from "../lib/i18n";

type JsonSchema = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  default?: unknown;
  enum?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
  items?: JsonSchema & { anyOf?: Array<{ const?: unknown; title?: string }> };
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

function asSchema(value: unknown): JsonSchema {
  return value && typeof value === "object" ? (value as JsonSchema) : {};
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function initialFormValues(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).flatMap(([key, property]) =>
      property.default === undefined ? [] : [[key, property.default]],
    ),
  );
}

function interactionTitle(
  interaction: UICodexInteraction,
  t: ReturnType<typeof useT>,
): string {
  switch (interaction.kind) {
    case "command_approval":
      return t("codexCommandRequest");
    case "file_approval":
      return t("codexFileRequest");
    case "permissions_approval":
      return t("codexPermissionsRequest");
    case "user_input":
      return t("codexInputRequest");
    case "mcp_elicitation":
      return t("codexMcpRequest");
  }
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
        {label}
      </div>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function ApprovalBody({ interaction }: { interaction: UICodexInteraction }) {
  const t = useT();
  if (interaction.kind === "command_approval") {
    return (
      <div className="space-y-4">
        <Detail label={t("codexCommandRequest")}>
          <pre className="thin-scroll max-h-48 overflow-auto rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {interaction.command || "(empty command)"}
          </pre>
        </Detail>
        {interaction.cwd && <Detail label={t("codexWorkingDirectory")}><code className="break-all text-xs">{interaction.cwd}</code></Detail>}
        {interaction.reason && <Detail label={t("codexReason")}><p className="whitespace-pre-wrap text-muted">{interaction.reason}</p></Detail>}
        {interaction.details !== undefined && (
          <Detail label={t("codexRequestDetails")}>
            <pre className="thin-scroll max-h-48 overflow-auto rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {printable(interaction.details)}
            </pre>
          </Detail>
        )}
      </div>
    );
  }
  if (interaction.kind === "file_approval") {
    return (
      <div className="space-y-4">
        {interaction.reason && <Detail label={t("codexReason")}><p className="whitespace-pre-wrap text-muted">{interaction.reason}</p></Detail>}
        {interaction.grantRoot && <Detail label={t("codexWorkingDirectory")}><code className="break-all text-xs">{interaction.grantRoot}</code></Detail>}
        {interaction.changes !== undefined && (
          <Detail label={t("codexChanges")}>
            <pre className="thin-scroll max-h-56 overflow-auto rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {printable(interaction.changes)}
            </pre>
          </Detail>
        )}
      </div>
    );
  }
  if (interaction.kind === "permissions_approval") {
    return (
      <div className="space-y-4">
        {interaction.reason && <Detail label={t("codexReason")}><p className="whitespace-pre-wrap text-muted">{interaction.reason}</p></Detail>}
        {interaction.cwd && <Detail label={t("codexWorkingDirectory")}><code className="break-all text-xs">{interaction.cwd}</code></Detail>}
        <Detail label={t("codexPermissions")}>
          <pre className="thin-scroll max-h-56 overflow-auto rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {printable(interaction.permissions)}
          </pre>
        </Detail>
      </div>
    );
  }
  return null;
}

function ChoiceButton({
  selected,
  label,
  description,
  selectionRole = "checkbox",
  onClick,
}: {
  selected: boolean;
  label: string;
  description?: string;
  selectionRole?: "checkbox" | "radio";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={selectionRole}
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-accent bg-accent/10 text-ink"
          : "border-line bg-canvas text-muted hover:bg-hover hover:text-ink"
      }`}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border text-[9px] ${
          selectionRole === "radio" ? "rounded-full" : "rounded"
        } ${
          selected ? "border-accent bg-accent text-accent-ink" : "border-faint"
        }`}
        aria-hidden
      >
        {selected ? selectionRole === "radio" ? "●" : "✓" : ""}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-faint">{description}</span>}
      </span>
    </button>
  );
}

function UserInputBody({
  interaction,
  answers,
  otherAnswers,
  onAnswersChange,
  onOtherChange,
}: {
  interaction: Extract<UICodexInteraction, { kind: "user_input" }>;
  answers: Record<string, string[]>;
  otherAnswers: Record<string, string>;
  onAnswersChange: (answers: Record<string, string[]>) => void;
  onOtherChange: (answers: Record<string, string>) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-5">
      {interaction.questions.map((question) => {
        const selected = answers[question.id] ?? [];
        const select = (label: string) => {
          onAnswersChange({
            ...answers,
            [question.id]: [label],
          });
          onOtherChange({ ...otherAnswers, [question.id]: "" });
        };
        return (
          <fieldset
            key={question.id}
            role={question.options?.length ? "radiogroup" : undefined}
            className="min-w-0"
          >
            <legend className="text-xs font-semibold tracking-wide text-faint uppercase">
              {question.header}
            </legend>
            <p className="mt-1 text-sm leading-relaxed text-ink">{question.question}</p>
            {question.options && question.options.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {question.options.map((option) => (
                  <ChoiceButton
                    key={option.label}
                    selected={selected.includes(option.label)}
                    label={option.label}
                    description={option.description}
                    selectionRole="radio"
                    onClick={() => select(option.label)}
                  />
                ))}
                <p className="px-1 text-[11px] text-faint">{t("codexSelectOptions")}</p>
              </div>
            )}
            {(question.allowOther || !question.options?.length) && (
              <input
                type={question.secret ? "password" : "text"}
                autoComplete="off"
                value={otherAnswers[question.id] ?? ""}
                onChange={(event) => {
                  onOtherChange({ ...otherAnswers, [question.id]: event.target.value });
                  if (event.target.value) onAnswersChange({ ...answers, [question.id]: [] });
                }}
                placeholder={t("codexOtherAnswer")}
                className="mt-2.5 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none placeholder:text-faint focus:border-faint"
              />
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

function enumOptions(schema: JsonSchema): Array<{ value: unknown; label: string }> {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap((option) =>
      option.const === undefined
        ? []
        : [{ value: option.const, label: option.title ?? String(option.const) }],
    );
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => ({ value, label: String(value) }));
  }
  const itemOptions = schema.items?.anyOf;
  if (Array.isArray(itemOptions)) {
    return itemOptions.flatMap((option) =>
      option.const === undefined
        ? []
        : [{ value: option.const, label: option.title ?? String(option.const) }],
    );
  }
  if (Array.isArray(schema.items?.enum)) {
    return schema.items.enum.map((value) => ({ value, label: String(value) }));
  }
  return [];
}

function McpFormBody({
  schema,
  values,
  onChange,
  rawValue,
  onRawValueChange,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  rawValue: string;
  onRawValueChange: (value: string) => void;
}) {
  const t = useT();
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) {
    return (
      <textarea
        value={rawValue}
        onChange={(event) => onRawValueChange(event.target.value)}
        aria-label={t("codexMcpFormData")}
        className="thin-scroll min-h-40 w-full resize-y rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-xs leading-relaxed text-ink outline-none focus:border-faint"
      />
    );
  }
  const required = new Set(schema.required ?? []);
  return (
    <div className="space-y-4">
      {properties.map(([key, property]) => {
        const options = enumOptions(property);
        const value = values[key];
        const label = property.title || key;
        const fieldLabel = `${label}${required.has(key) ? " *" : ""}`;
        if (property.type === "boolean") {
          return (
            <label key={key} className="flex items-start gap-3 rounded-xl border border-line bg-canvas px-3 py-2.5">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange({ ...values, [key]: event.target.checked })}
                className="mt-0.5 size-4 accent-current"
              />
              <span className="min-w-0 text-sm text-ink">
                <span className="font-medium">{fieldLabel}</span>
                {property.description && <span className="mt-0.5 block text-xs text-faint">{property.description}</span>}
              </span>
            </label>
          );
        }
        if (property.type === "array" && options.length > 0) {
          const selected = Array.isArray(value) ? value : [];
          return (
            <fieldset key={key}>
              <legend className="text-sm font-medium text-ink">{fieldLabel}</legend>
              {property.description && <p className="mt-0.5 text-xs text-faint">{property.description}</p>}
              <div className="mt-2 space-y-2">
                {options.map((option) => (
                  <ChoiceButton
                    key={String(option.value)}
                    selected={selected.includes(option.value)}
                    label={option.label}
                    onClick={() =>
                      onChange({
                        ...values,
                        [key]: selected.includes(option.value)
                          ? selected.filter((item) => item !== option.value)
                          : [...selected, option.value],
                      })
                    }
                  />
                ))}
              </div>
            </fieldset>
          );
        }
        if (options.length > 0) {
          return (
            <label key={key} className="block">
              <span className="text-sm font-medium text-ink">{fieldLabel}</span>
              {property.description && <span className="mt-0.5 block text-xs text-faint">{property.description}</span>}
              <select
                value={value === undefined ? "" : String(value)}
                onChange={(event) => {
                  const option = options.find((candidate) => String(candidate.value) === event.target.value);
                  onChange({ ...values, [key]: option?.value ?? event.target.value });
                }}
                className="mt-2 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-faint"
              >
                <option value="">—</option>
                {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
              </select>
            </label>
          );
        }
        const inputType =
          property.type === "number" || property.type === "integer"
            ? "number"
            : property.format === "email"
              ? "email"
            : property.format === "uri"
              ? "url"
              : property.format === "password"
                ? "password"
              : property.format === "date"
                  ? "date"
                  : "text";
        return (
          <label key={key} className="block">
            <span className="text-sm font-medium text-ink">{fieldLabel}</span>
            {property.description && <span className="mt-0.5 block text-xs text-faint">{property.description}</span>}
            <input
              type={inputType}
              autoComplete={inputType === "password" ? "off" : undefined}
              required={required.has(key)}
              value={value === undefined ? "" : String(value)}
              onChange={(event) =>
                onChange({
                  ...values,
                  [key]: inputType === "number"
                    ? event.target.value === "" ? undefined : Number(event.target.value)
                    : event.target.value,
                })
              }
              className="mt-2 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-faint"
            />
          </label>
        );
      })}
    </div>
  );
}

/** A reconnect-safe, explicitly user-controlled bridge for Codex app-server requests. */
export function CodexInteractionHost() {
  const t = useT();
  const { pendingInteractions } = useChat();
  const interaction = pendingInteractions[0] ?? null;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [rawFormValue, setRawFormValue] = useState("{}");
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const interactionId = interaction?.id;
  const formSchema = useMemo(
    () => interaction?.kind === "mcp_elicitation" ? asSchema(interaction.schema) : {},
    // The request id is the app-server identity. Snapshot refreshes may rebuild
    // the wrapper object while the user is halfway through a form; do not wipe
    // their answers unless the actual blocking request changes.
    [interactionId],
  );

  useEffect(() => {
    setAnswers({});
    setOtherAnswers({});
    setFormValues(initialFormValues(formSchema));
    setRawFormValue("{}");
    setSubmittingId(null);
    setFormError(null);
  }, [interactionId, formSchema]);

  if (!interaction) return null;
  const submitting = submittingId === interaction.id;

  const respond = (response: Omit<UICodexInteractionResponse, "id">) => {
    if (submitting) return;
    const sent = chatClient.respondCodexInteraction({ id: interaction.id, ...response });
    if (sent) setSubmittingId(interaction.id);
    else chatClient.reportError(t("codexInteractionSendFailed"));
  };

  const cancel = () => respond({ action: "cancel" });
  const submitUserInput = () => {
    if (interaction.kind !== "user_input") return;
    const merged = Object.fromEntries(
      interaction.questions.map((question) => {
        const other = otherAnswers[question.id]?.trim();
        return [question.id, [...(answers[question.id] ?? []), ...(other ? [other] : [])]];
      }),
    );
    if (Object.values(merged).some((values) => values.length === 0)) {
      setFormError(t("codexRequired"));
      return;
    }
    respond({ action: "submit", answers: merged });
  };
  const submitMcpForm = () => {
    if (interaction.kind !== "mcp_elicitation") return;
    if (Object.keys(formSchema.properties ?? {}).length > 0) {
      const missing = (formSchema.required ?? []).some((key) => {
        const value = formValues[key];
        return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
      });
      if (missing) {
        setFormError(t("codexRequired"));
        return;
      }
      respond({ action: "submit", content: formValues });
      return;
    }
    try {
      respond({ action: "submit", content: JSON.parse(rawFormValue) as unknown });
    } catch {
      setFormError(t("codexInvalidForm"));
    }
  };

  const approval = interaction.kind === "command_approval"
    || interaction.kind === "file_approval"
    || interaction.kind === "permissions_approval";
  const externalUrl = interaction.kind === "mcp_elicitation" && interaction.mode === "url"
    ? safeExternalUrl(interaction.url)
    : null;

  return (
    <Dialog.Root open onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed right-0 bottom-0 left-0 z-[60] flex max-h-[92dvh] flex-col overflow-hidden rounded-t-3xl border border-line bg-card shadow-[0_-18px_60px_rgba(0,0,0,0.18)] outline-none sm:top-1/2 sm:right-auto sm:bottom-auto sm:left-1/2 sm:max-h-[85vh] sm:w-[min(92vw,34rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:shadow-[0_22px_70px_rgba(0,0,0,0.22)]">
          <div className="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-400/10 text-amber-600 dark:text-amber-300" aria-hidden>
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                <path d="M12 3 4.5 6v5.5c0 4.5 3.1 7.7 7.5 9.5 4.4-1.8 7.5-5 7.5-9.5V6L12 3Z" strokeLinejoin="round" />
                <path d="M12 8v5M12 16.5h.01" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-semibold tracking-tight text-ink">
                {interactionTitle(interaction, t)}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs leading-relaxed text-faint">
                {t("codexApprovalTitle")}
              </Dialog.Description>
            </div>
            {pendingInteractions.length > 1 && (
              <span className="shrink-0 rounded-full border border-line bg-canvas px-2 py-1 font-mono text-[10px] text-muted">
                {t("codexApprovalQueue", { count: pendingInteractions.length })}
              </span>
            )}
          </div>

          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            <ApprovalBody interaction={interaction} />
            {interaction.kind === "user_input" && (
              <UserInputBody
                interaction={interaction}
                answers={answers}
                otherAnswers={otherAnswers}
                onAnswersChange={(next) => {
                  setAnswers(next);
                  setFormError(null);
                }}
                onOtherChange={(next) => {
                  setOtherAnswers(next);
                  setFormError(null);
                }}
              />
            )}
            {interaction.kind === "mcp_elicitation" && (
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-semibold tracking-wide text-faint uppercase">{interaction.serverName}</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">{interaction.message}</p>
                </div>
                {interaction.mode === "url" ? (
                  externalUrl && (
                    <a
                      href={externalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-accent bg-accent/10 px-3 text-sm font-medium text-ink transition-colors hover:bg-accent/15"
                    >
                      {t("codexOpenAuthorization")}
                    </a>
                  )
                ) : (
                  <McpFormBody
                    schema={formSchema}
                    values={formValues}
                    onChange={(values) => {
                      setFormValues(values);
                      setFormError(null);
                    }}
                    rawValue={rawFormValue}
                    onRawValueChange={(value) => {
                      setRawFormValue(value);
                      setFormError(null);
                    }}
                  />
                )}
              </div>
            )}
            {formError && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{formError}</p>}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:pb-3">
            <button
              type="button"
              disabled={submitting}
              onClick={cancel}
              className="min-h-9 rounded-lg border border-line px-3 text-sm text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
            >
              {t("codexCancelTurn")}
            </button>
            {(approval || interaction.kind === "mcp_elicitation") && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => respond({ action: "decline" })}
                className="min-h-9 rounded-lg border border-line px-3 text-sm text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                {t("codexDecline")}
              </button>
            )}
            {interaction.kind === "user_input" && (
              <button type="button" disabled={submitting} onClick={submitUserInput} className="min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50">
                {t("codexSubmit")}
              </button>
            )}
            {interaction.kind === "mcp_elicitation" && (
              <button
                type="button"
                disabled={submitting || (interaction.mode === "url" && !externalUrl)}
                onClick={() => interaction.mode === "url" ? respond({ action: "accept" }) : submitMcpForm()}
                className="min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {interaction.mode === "url" ? t("codexAuthorizationDone") : t("codexSubmit")}
              </button>
            )}
            {approval && (
              <>
                {interaction.kind !== "permissions_approval" && interaction.allowSessionApproval && (
                  <button type="button" disabled={submitting} onClick={() => respond({ action: "accept_for_session" })} className="min-h-9 rounded-lg border border-accent px-3 text-sm font-medium text-ink transition-colors hover:bg-accent/10 disabled:opacity-50">
                    {t("codexAcceptSession")}
                  </button>
                )}
                {interaction.kind === "permissions_approval" && (
                  <button type="button" disabled={submitting} onClick={() => respond({ action: "accept", scope: "session" })} className="min-h-9 rounded-lg border border-accent px-3 text-sm font-medium text-ink transition-colors hover:bg-accent/10 disabled:opacity-50">
                    {t("codexAcceptSession")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => respond({ action: "accept", ...(interaction.kind === "permissions_approval" ? { scope: "turn" as const } : {}) })}
                  className="min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {t("codexAcceptOnce")}
                </button>
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
