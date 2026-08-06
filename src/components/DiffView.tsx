import { useMemo } from "react";
import { parseDiff, type DiffLineKind } from "../lib/diff";

const KIND_CLASS: Record<DiffLineKind, string> = {
  header: "text-faint",
  hunk: "bg-faint/10 text-muted font-semibold",
  // 新增 = 파랑, 삭제 = 빨강 (빨파 스킴)
  add: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  del: "bg-red-500/10 text-red-600 dark:text-red-400",
  context: "text-muted",
  nonewline: "text-faint italic",
  plain: "text-ink",
};

/**
 * unified diff 를 행 번호 + 빨강(삭제)/파랑(추가) 스킴으로 렌더.
 * 구/신 두 행 번호 거터 + 내용 (코드 블록은 JetBrainsMono Nerd Font).
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
          <span className="w-10 shrink-0 pr-2 text-right tabular-nums opacity-40 select-none">
            {l.oldNo ?? ""}
          </span>
          <span className="w-10 shrink-0 pr-2 text-right tabular-nums opacity-40 select-none">
            {l.newNo ?? ""}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre">{l.text}</span>
        </div>
      ))}
    </pre>
  );
}
