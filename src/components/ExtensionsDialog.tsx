import { Dialog } from "@base-ui-components/react/dialog";
import type { UIExtensionInfo } from "../../shared/protocol";
import { useExtensions } from "../lib/api";
import { useT } from "../lib/i18n";
import { LoadingIndicator } from "./LoadingIndicator";

function DetailRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex items-baseline gap-1.5 text-[11px] leading-relaxed">
      <span className="shrink-0 text-faint">{label}</span>
      <span className="font-mono break-all text-muted">
        {items.join(", ")}
      </span>
    </div>
  );
}

/** Extensions loaded in the current session */
export function ExtensionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { data, isPending, isFetching, refetch } = useExtensions(open);
  const extensions = data?.extensions ?? [];
  const errors = data?.errors ?? [];

  const scopeLabel: Record<UIExtensionInfo["scope"], string> = {
    user: t("scopeUser"),
    project: t("scopeProject"),
    temporary: t("scopeTemporary"),
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) void refetch();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[75vh] w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-card shadow-xl outline-none">
          <div className="border-b border-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{t("activeExtensions")}</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-faint">
              {data
                ? t("extensionsLoaded", { count: extensions.length })
                : t("extensionsLoading")}
            </Dialog.Description>
          </div>

          <div className="relative flex-1 overflow-y-auto">
            {isPending ? (
              <div className="flex justify-center px-4 py-8">
                <LoadingIndicator label={t("extensionsLoading")} showLabel />
              </div>
            ) : (
              <>
            {errors.length > 0 && (
              <div className="border-b border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/40">
                <div className="text-xs font-semibold text-red-600 dark:text-red-400">
                  {t("loadFailures", { count: errors.length })}
                </div>
                {errors.map((e) => (
                  <div key={e.path} className="mt-1.5 text-[11px]">
                    <div className="font-mono break-all text-red-500 dark:text-red-400">
                      {e.path}
                    </div>
                    <div className="text-red-500/80 dark:text-red-400/80">{e.error}</div>
                  </div>
                ))}
              </div>
            )}

            {extensions.map((ext) => (
              <div
                key={ext.path}
                className="border-b border-line px-4 py-3 last:border-0"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-ink">
                    {ext.name}
                  </span>
                  {ext.packageName && (
                    <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {ext.packageName}
                    </span>
                  )}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      ext.scope === "project"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                        : ext.scope === "temporary"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                          : "bg-accent-soft text-accent"
                    }`}
                  >
                    {scopeLabel[ext.scope]}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
                  {ext.path}
                </div>
                <DetailRow label={t("tools")} items={ext.tools} />
                <DetailRow label={t("commands")} items={ext.commands} />
                <DetailRow label={t("flags")} items={ext.flags} />
                <DetailRow label={t("events")} items={ext.events} />
              </div>
            ))}

            {data && extensions.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-faint">
                {t("noExtensionsLoaded")}
              </div>
            )}
              </>
            )}
            {isFetching && !isPending && <LoadingIndicator label={t("loading")} size="sm" className="absolute top-3 right-4" />}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
