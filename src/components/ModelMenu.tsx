import { Menu } from "@base-ui-components/react/menu";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIModel } from "../../shared/protocol";
import { useModels } from "../lib/api";
import { chatClient, useChat } from "../lib/chat";
import { useT } from "../lib/i18n";
import { LoadingIndicator } from "./LoadingIndicator";

function modelLabel(model: UIModel) {
  return model.name?.trim() || model.id;
}

function matchesQuery(model: UIModel, q: string) {
  if (!q) return true;
  const hay = `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase();
  return hay.includes(q);
}

export function ModelMenu({ current, openToken = 0 }: { current: UIModel | null; openToken?: number }) {
  const t = useT();
  const { snapshot } = useChat();
  const { data: models, isPending, isFetching } = useModels(snapshot?.agent);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? [])
      .filter((m) => matchesQuery(m, q))
      .sort((a, b) => {
        const byName = modelLabel(a).localeCompare(modelLabel(b), undefined, {
          numeric: true,
          sensitivity: "base",
        });
        return byName || a.provider.localeCompare(b.provider, undefined, { sensitivity: "base" });
      });
  }, [models, query]);

  // The menu's focus manager grabs focus first; then re-focus the search input
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const focus = () => inputRef.current?.focus();
    const t1 = window.setTimeout(focus, 0);
    const t2 = window.setTimeout(focus, 50);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [open]);

  useEffect(() => {
    if (openToken > 0) setOpen(true);
  }, [openToken]);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="max-w-[40vw] truncate rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink sm:max-w-xs">
        {current ? (current.name ?? current.id) : t("selectModel")}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="flex w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-card shadow-xl outline-none">
            <div className="border-b border-line p-2">
              <div className="flex items-center gap-2 rounded-lg bg-hover px-2.5">
                <svg
                  viewBox="0 0 24 24"
                  className="size-4 shrink-0 fill-none stroke-current stroke-2 text-faint"
                  aria-hidden
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3-3" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchModels")}
                  aria-label={t("searchModels")}
                  autoFocus
                  className="w-full bg-transparent py-2 text-sm text-ink outline-none placeholder:text-faint"
                  // Avoid colliding with menu typeahead / arrow-key navigation
                  onKeyDown={(e) => {
                    if (e.key === "Escape") return;
                    // Down arrow moves to the list
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      e.currentTarget.blur();
                      return;
                    }
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                    className="shrink-0 text-faint hover:text-ink"
                    aria-label={t("clearSearch")}
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
                      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            <div className="relative max-h-[min(50vh,22rem)] overflow-y-auto py-1">
              {isPending ? (
                <div className="flex justify-center px-3 py-6">
                  <LoadingIndicator label={t("loading")} showLabel />
                </div>
              ) : (
                filtered.map((m) => {
                const active = current && m.provider === current.provider && m.id === current.id;
                return (
                  <Menu.Item
                    key={`${m.provider}/${m.id}`}
                    onClick={() =>
                      chatClient.send({ type: "set_model", provider: m.provider, id: m.id })
                    }
                    className={`flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2 text-sm outline-none data-[highlighted]:bg-hover ${
                      active ? "text-accent" : "text-ink"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{modelLabel(m)}</span>
                    <span className="max-w-[42%] shrink-0 truncate text-right text-xs text-faint">{m.provider}</span>
                  </Menu.Item>
                );
                })
              )}
              {isFetching && !isPending && <LoadingIndicator label={t("loading")} size="sm" className="absolute top-3 right-3" />}
              {!isPending && filtered.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-faint">
                  {models && models.length === 0 ? t("noModelsAvailable") : t("noSearchResults")}
                </div>
              )}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
