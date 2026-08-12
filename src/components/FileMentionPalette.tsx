import type { UIFileMatch } from "../../shared/protocol";
import { useT } from "../lib/i18n";

const POPUP_CLASS =
  "absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-lg border border-line bg-card shadow-lg";

export function FileMentionPalette({
  matches,
  activeIndex,
  partial,
  onSelect,
}: {
  matches: UIFileMatch[];
  activeIndex: number;
  partial?: boolean;
  onSelect: (match: UIFileMatch) => void;
}) {
  const t = useT();
  if (matches.length === 0) {
    return <div className={`${POPUP_CLASS} px-3 py-3 text-sm text-faint`}>{t("mentionNoFiles")}</div>;
  }
  return (
    <div className={`${POPUP_CLASS} max-h-72 overflow-y-auto py-1`} role="listbox" aria-label={t("files")}>
      {matches.map((match, index) => (
        <button
          key={match.path}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(match)}
          className={`flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors ${
            index === activeIndex ? "bg-hover" : "hover:bg-hover"
          }`}
        >
          <span className="shrink-0 font-mono text-[12px] text-faint" aria-hidden>
            {match.type === "dir" ? "\uf114" : "\uf016"}
          </span>
          <span className="shrink-0 font-mono text-[13px] text-ink">
            {match.name}
            {match.type === "dir" ? "/" : ""}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-faint">{match.path}</span>
        </button>
      ))}
      {partial && <div className="px-3 py-1 text-[10px] text-faint">{t("mentionPartial")}</div>}
    </div>
  );
}
