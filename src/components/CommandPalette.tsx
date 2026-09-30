import type { UIAgentKind, UICommandInfo } from "../../shared/protocol";
import { useT } from "../lib/i18n";
import { PALETTE_POPUP_CLASS } from "./ui";

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

function SourceLabel({ source, agent }: { source: UICommandInfo["source"]; agent?: UIAgentKind }) {
  const t = useT();
  const labels: Record<UICommandInfo["source"], string> = {
    builtin: agent === "codex" ? t("commandSourceCodex") : t("commandSourceBuiltin"),
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
  agent,
}: {
  matches: UICommandInfo[];
  activeIndex: number;
  onSelect: (command: UICommandInfo) => void;
  agent?: UIAgentKind;
}) {
  const t = useT();
  const bySource = new Map<UICommandInfo["source"], UICommandInfo[]>();
  for (const source of SOURCE_ORDER) bySource.set(source, []);
  for (const command of matches) bySource.get(command.source)?.push(command);

  if (matches.length === 0) {
    return (
      <div className={`${PALETTE_POPUP_CLASS} px-3 py-3 text-sm text-faint`}>
        {t("noCommandsFound")}
      </div>
    );
  }

  let itemIndex = 0;
  return (
    <div
      className={`${PALETTE_POPUP_CLASS} max-h-72 overflow-y-auto py-1`}
      role="listbox"
      aria-label={t("commands")}
    >
      {SOURCE_ORDER.map((source) => {
        const items = bySource.get(source) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={source} className="py-1">
            <div className="px-3 pt-1 pb-1 text-[10px] font-medium tracking-wide text-faint uppercase">
              <SourceLabel source={source} agent={agent} />
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
