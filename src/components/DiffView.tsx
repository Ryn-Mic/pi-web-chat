import { useMemo } from "react";
import { parseDiff, type DiffLineKind } from "../lib/diff";

const KIND_CLASS: Record<DiffLineKind, string> = {
  header: "text-faint",
  hunk: "bg-faint/10 text-muted font-semibold",
  // added = blue, deleted = red (blue/red scheme)
  add: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  del: "bg-red-500/10 text-red-600 dark:text-red-400",
  context: "text-muted",
  nonewline: "text-faint italic",
  ellipsis: "text-faint select-none",
  plain: "text-ink",
};

/**
 * Render a unified diff with line numbers and a red(delete)/blue(add) scheme.
 * Old/new line-number gutters + content (code blocks use JetBrainsMono Nerd
 * Font). Gutter columns are narrow on mobile so the content gets the room.
 */
export function DiffView({
  text,
  maxHeight = "max-h-64",
}: {
  text: string;
  maxHeight?: string;
}) {
  const lines = useMemo(() => parseDiff(text), [text]);
  return (
    <pre
      className={`${maxHeight} overflow-auto rounded-lg font-mono text-xs leading-relaxed whitespace-pre`}
    >
      {lines.map((l, i) => (
        <div key={i} className={`flex ${KIND_CLASS[l.kind]}`}>
          <span className="w-7 shrink-0 pr-1.5 text-right tabular-nums opacity-40 select-none sm:w-10 sm:pr-2">
            {l.oldNo ?? ""}
          </span>
          <span className="w-7 shrink-0 pr-1.5 text-right tabular-nums opacity-40 select-none sm:w-10 sm:pr-2">
            {l.newNo ?? ""}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre">{l.text}</span>
        </div>
      ))}
    </pre>
  );
}
