import { Dialog } from "@base-ui-components/react/dialog";
import { useEffect, useState } from "react";
import { chatClient, useChat } from "../lib/chat";
import { useT } from "../lib/i18n";

/** Browser implementation of the dialog-capable portion of pi's extension UI. */
export function ExtensionUIHost() {
  const t = useT();
  const { extensionUIRequest: request } = useChat();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!request) return;
    setValue(request.method === "editor" ? (request.prefill ?? "") : "");
  }, [request]);

  const cancel = () => {
    if (request) chatClient.respondExtensionUI({ id: request.id, cancelled: true });
  };

  if (!request) return null;

  const submitValue = () => chatClient.respondExtensionUI({ id: request.id, value });

  return (
    <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[75vh] w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-card shadow-xl outline-none">
          <div className="border-b border-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-ink">{request.title}</Dialog.Title>
            {request.method === "confirm" && (
              <Dialog.Description className="mt-1 whitespace-pre-wrap text-sm text-muted">
                {request.message}
              </Dialog.Description>
            )}
          </div>

          {request.method === "select" && (
            <div>
              <div className="max-h-80 overflow-y-auto py-1">
                {request.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => chatClient.respondExtensionUI({ id: request.id, value: option })}
                    className="block w-full px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-hover"
                  >
                    {option}
                  </button>
                ))}
              </div>
              <div className="flex justify-end border-t border-line px-4 py-3">
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}

          {request.method === "confirm" && (
            <div className="flex justify-end gap-2 px-4 py-3">
              <button
                type="button"
                onClick={cancel}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => chatClient.respondExtensionUI({ id: request.id, confirmed: true })}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
              >
                Confirm
              </button>
            </div>
          )}

          {(request.method === "input" || request.method === "editor") && (
            <form
              className="flex flex-col gap-3 px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                submitValue();
              }}
            >
              {request.method === "editor" ? (
                <textarea
                  autoFocus
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="min-h-40 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-faint"
                />
              ) : (
                <input
                  autoFocus
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={request.placeholder}
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-faint"
                />
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
                >
                  {t("save")}
                </button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
