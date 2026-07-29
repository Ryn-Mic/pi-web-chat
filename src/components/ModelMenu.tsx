import { Menu } from "@base-ui-components/react/menu";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIModel } from "../../shared/protocol";
import { useModels } from "../lib/api";
import { chatClient } from "../lib/chat";
import { useT } from "../lib/i18n";

function matchesQuery(model: UIModel, q: string) {
  if (!q) return true;
  const hay = `${model.name ?? ""} ${model.id} ${model.provider}`.toLowerCase();
  return hay.includes(q);
}

export function ModelMenu({ current }: { current: UIModel | null }) {
  const t = useT();
  const { data: models } = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => matchesQuery(m, q));
  }, [models, query]);

  // Menu 내부 focus manager가 먼저 잡은 뒤 검색창으로 재포커스
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

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="max-w-[40vw] truncate rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink sm:max-w-xs">
        {current ? (current.name ?? current.id) : t("selectModel")}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="flex w-72 flex-col overflow-hidden rounded-xl border border-line bg-card shadow-xl outline-none">
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
                  // 메뉴 typeahead / 화살표 네비와 충돌 방지
                  onKeyDown={(e) => {
                    if (e.key === "Escape") return;
                    // 아래 화살표는 목록으로 넘김
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

            <div className="max-h-[min(50vh,22rem)] overflow-y-auto py-1">
              {filtered.map((m) => {
                const active = current && m.provider === current.provider && m.id === current.id;
                return (
                  <Menu.Item
                    key={`${m.provider}/${m.id}`}
                    onClick={() =>
                      chatClient.send({ type: "set_model", provider: m.provider, id: m.id })
                    }
                    className={`flex cursor-pointer flex-col px-3 py-2 text-sm outline-none data-[highlighted]:bg-hover ${
                      active ? "text-accent" : "text-ink"
                    }`}
                  >
                    <span className="truncate">{m.name ?? m.id}</span>
                    <span className="text-xs text-faint">{m.provider}</span>
                  </Menu.Item>
                );
              })}
              {filtered.length === 0 && (
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
