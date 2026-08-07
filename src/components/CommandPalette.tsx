import type { UICommandInfo } from "../../shared/protocol";
import { useT } from "../lib/i18n";

const SOURCE_ORDER: UICommandInfo["source"][] = ["builtin", "extension", "prompt", "skill"];

export function commandMatches(commands: UICommandInfo[], text: string): UICommandInfo[] {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const token = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
  const query = token.toLowerCase();
  return commands.filter((command) => {
    const haystack = `${command.name} ${command.description ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

function SourceLabel({ source }: { source: UICommandInfo["source"] }) {
  const t = useT();
  const labels: Record<UICommandInfo["source"], string> = {
    builtin: t("commandSourceBuiltin"),
    extension: t("commandSourceExtension"),
    prompt: t("commandSourcePrompt"),
    skill: t("commandSourceSkill"),
  };
  return <span className="text-[10px] font-medium text-faint">{labels[source]}</span>;
}

export function CommandPalette({
  matches,
  activeIndex,
  onSelect,
}: {
  matches: UICommandInfo[];
  activeIndex: number;
  onSelect: (command: UICommandInfo) => void;
}) {
  const t = useT();
  const bySource = new Map<UICommandInfo["source"], UICommandInfo[]>();
  for (const source of SOURCE_ORDER) bySource.set(source, []);
  for (const command of matches) bySource.get(command.source)?.push(command);

  if (matches.length === 0) {
    return (
      <div className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-lg border border-line bg-card px-3 py-3 text-sm text-faint shadow-lg">
        {t("noCommandsFound")}
      </div>
    );
  }

  let itemIndex = 0;
  return (
    <div
      className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 max-h-72 overflow-y-auto rounded-lg border border-line bg-card py-1 shadow-lg"
      role="listbox"
      aria-label={t("commands")}
    >
      {SOURCE_ORDER.map((source) => {
        const items = bySource.get(source) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={source} className="py-1">
            <div className="px-3 pt-1 pb-1 text-[10px] font-medium tracking-wide text-faint uppercase">
              <SourceLabel source={source} />
            </div>
            {items.map((command) => {
              const index = itemIndex++;
              const active = index === activeIndex;
              return (
                <button
                  key={`${command.source}:${command.name}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(command)}
                  className={`flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors ${
                    active ? "bg-hover" : "hover:bg-hover"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">/{command.name}</span>
                  {command.argumentHint && (
                    <span className="shrink-0 font-mono text-[11px] text-faint">{command.argumentHint}</span>
                  )}
                  {command.description && (
                    <span className="hidden max-w-[45%] truncate text-xs text-muted sm:inline">{command.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
