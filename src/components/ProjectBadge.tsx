import type { UIActiveTodo } from "../../shared/protocol";

/**
 * Compact project + git branch status for the composer status row.
 * Style reference: zentui extension footer — cwd basename + git branch with
 * Nerd Font glyphs (JetBrainsMono Nerd Font is bundled in this app).
 */
export function ProjectBadge({
  cwd,
}: {
  cwd?: string;
}) {
  const project = projectLabel(cwd);
  if (!project) return null;

  return (
    <span
      className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[10px] leading-none text-muted sm:text-xs"
      title={cwd}
    >
      <span className="text-faint" aria-hidden>
        {/* nf-fa-folder_open_o */}
        &#xf115;
      </span>
      <span className="truncate">{project}</span>
    </span>
  );
}

export function ActiveTodoBadge({ todo }: { todo?: UIActiveTodo }) {
  if (!todo) return null;
  const label = todo.activeForm ?? todo.subject;

  return (
    <span
      className="flex min-w-0 items-center justify-center gap-1.5 overflow-hidden font-mono text-[10px] leading-none text-muted sm:text-xs"
      title={label}
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
      <span className="fade-x-compact min-w-0 truncate">{label}</span>
    </span>
  );
}

export function TodoProgress({ todo }: { todo?: UIActiveTodo }) {
  if (!todo) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint sm:text-xs">
      {todo.current}/{todo.total}
    </span>
  );
}

export function BranchBadge({
  gitBranch,
}: {
  gitBranch?: string | null;
}) {
  if (!gitBranch) return null;

  return (
    <span
      className="flex min-w-0 max-w-[55%] items-center gap-1.5 overflow-hidden font-mono text-[10px] leading-none text-faint sm:text-xs"
      title={gitBranch}
    >
      {/* nf-oct-git_branch */}
      <span className="shrink-0" aria-hidden>
        &#xf418;
      </span>
      <span className="truncate text-muted">{gitBranch}</span>
    </span>
  );
}

/** ~/a/b/project → "project" (basename, like zentui's basename path mode) */
function projectLabel(cwd?: string): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? cwd) : cwd;
}
