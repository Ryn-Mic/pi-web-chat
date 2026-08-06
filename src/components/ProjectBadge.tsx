/**
 * Project + git branch badge in the chat header.
 * Style reference: zentui extension footer — cwd basename + git branch with
 * Nerd Font glyphs (JetBrainsMono Nerd Font is bundled in this app).
 */
export function ProjectBadge({
  cwd,
  gitBranch,
}: {
  cwd?: string;
  gitBranch?: string | null;
}) {
  const project = projectLabel(cwd);
  if (!project) return null;

  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted">
      <span className="truncate">
        <span className="text-faint" aria-hidden>
          {/* nf-fa-folder_open_o */}
          &#xf115;
        </span>{" "}
        {project}
      </span>
      {gitBranch && (
        <span className="flex shrink-0 items-center gap-1 text-faint">
          {/* nf-oct-git_branch */}
          <span aria-hidden>&#xf418;</span>
          <span className="max-w-28 truncate text-muted">{gitBranch}</span>
        </span>
      )}
    </span>
  );
}

/** ~/a/b/project → "project" (basename, like zentui's basename path mode) */
function projectLabel(cwd?: string): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? cwd) : cwd;
}
