import { useMemo } from "react";
import { parseDiff, type DiffLineKind } from "../lib/diff";

const KIND_CLASS: Record<DiffLineKind, string> = {
  header: "bg-selected/70 text-faint",
  hunk: "border-y border-line bg-sidebar text-muted",
  add: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  context: "text-muted",
  nonewline: "text-faint italic",
  ellipsis: "text-faint select-none",
  plain: "text-ink",
};

function splitLine(line: { kind: DiffLineKind; text: string }) {
  if (line.kind === "add" || line.kind === "del" || line.kind === "context") {
    return { marker: line.text.slice(0, 1), content: line.text.slice(1) };
  }
  return { marker: "", content: line.text };
}

/**
 * Render a unified diff with a stable old/new line-number gutter. This is a
 * div-based grid rather than a pre containing divs: that keeps each row valid
 * HTML and makes horizontal scrolling consistent on Safari.
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
    <div
      className={`diff-view ${maxHeight} overflow-auto rounded-md border border-line bg-canvas font-mono text-[11px] leading-5`}
    >
      {/* The inner flex column is sized by the longest diff row. Every child
          stretches to that same width, so short hunk/header backgrounds do
          not end halfway through the horizontal scroll range. */}
      <div className="inline-flex min-w-full flex-col">
        {lines.map((l, i) => {
          const isMeta =
            l.kind === "header" ||
            l.kind === "hunk" ||
            l.kind === "nonewline" ||
            l.kind === "ellipsis" ||
            l.kind === "plain";
          if (isMeta) {
            return (
              <div key={i} className={`px-2 whitespace-pre ${KIND_CLASS[l.kind]}`}>
                {l.text}
              </div>
            );
          }
          const { marker, content } = splitLine(l);
          return (
            <div key={i} className={`flex min-w-max ${KIND_CLASS[l.kind]}`}>
              <span className="w-7 shrink-0 pr-1 text-right tabular-nums opacity-45 select-none sm:w-9">
                {l.oldNo ?? ""}
              </span>
              <span className="w-7 shrink-0 pr-1 text-right tabular-nums opacity-45 select-none sm:w-9">
                {l.newNo ?? ""}
              </span>
              <span className="w-4 shrink-0 text-center font-semibold select-none">{marker}</span>
              <span className="pr-3 whitespace-pre">{content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
