import { Dialog } from "@base-ui-components/react/dialog";
import { useForkPoints } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { useT } from "../lib/i18n";
import { LoadingIndicator } from "./LoadingIndicator";

/** Fork into a new session from a specific user-message point */
export function ForkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { sessionId, snapshot, pendingInteractions } = useChat();
  const isCodex = snapshot?.agent === "codex";
  const hasCodexThread = !!snapshot?.codex?.threadId && !!sessionId;
  const codexUnavailable =
    !!snapshot?.isStreaming || !!snapshot?.codex?.observer || pendingInteractions.length > 0;
  const canForkCodex = isCodex && hasCodexThread && !codexUnavailable;
  const { data: points, isPending, isFetching, refetch } = useForkPoints(
    sessionId,
    open && !isCodex,
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next && !isCodex) void refetch();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 flex max-h-[75vh] w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-card shadow-xl outline-none">
          <div className="border-b border-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{t("forkSession")}</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-faint">
              {t(isCodex ? "codexForkDescription" : "forkDescription")}
            </Dialog.Description>
            {!isCodex && isFetching && <LoadingIndicator label={t("loading")} size="sm" className="mt-2" showLabel />}
          </div>
          {isCodex ? (
            <div className="flex flex-col gap-4 px-4 py-4">
              {(!hasCodexThread || codexUnavailable) && (
                <p
                  className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs leading-relaxed text-muted"
                  role="status"
                  aria-live="polite"
                >
                  {t(hasCodexThread ? "codexForkUnavailable" : "codexForkNoThread")}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  autoFocus
                  onClick={() => onOpenChange(false)}
                  className="min-h-10 rounded-lg border border-line px-4 py-2 text-sm text-muted transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  disabled={!canForkCodex}
                  onClick={() => {
                    if (!sessionId || !canForkCodex) return;
                    if (chatClient.send({ type: "fork", entryId: sessionId })) {
                      onOpenChange(false);
                    }
                  }}
                  className="min-h-10 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("codexForkAction")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto py-1">
              {isPending ? (
                <div className="flex justify-center px-4 py-8">
                  <LoadingIndicator label={t("loading")} showLabel />
                </div>
              ) : (
                (points ?? []).map((p, i) => (
                  <button
                    type="button"
                    key={p.entryId}
                    onClick={() => {
                      chatClient.send({ type: "fork", entryId: p.entryId });
                      onOpenChange(false);
                    }}
                    className="block w-full px-4 py-2.5 text-left hover:bg-hover"
                  >
                    <span className="mr-2 font-mono text-xs text-faint">#{i + 1}</span>
                    <span className="text-sm text-ink">
                      {p.text.slice(0, 100) || t("emptyMessage")}
                    </span>
                  </button>
                ))
              )}
              {!isPending && points && points.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-faint">
                  {t("noForkPoints")}
                </div>
              )}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
