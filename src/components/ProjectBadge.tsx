import { useEffect, useRef, useState } from "react";
import type { UIActiveTodo } from "../../shared/protocol";
import { activityEyeState, activityEyeTone } from "../lib/activity";
import { AgentEyes } from "./AgentEyes";

/**
 * Compact project status badge for the header.
 * Style reference: zentui extension footer — cwd basename with
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
      className="flex min-w-0 max-w-[50%] shrink items-center gap-1.5 overflow-hidden font-mono text-[10px] leading-none text-muted sm:max-w-[40%] sm:text-xs"
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

function ScrollingLabel({ label }: { label: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      setScrollDistance(Math.max(0, content.scrollWidth - viewport.clientWidth));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [label]);

  return (
    <span ref={viewportRef} className="min-w-0 flex-1 overflow-hidden whitespace-nowrap" title={label}>
      <span
        ref={contentRef}
        className={`inline-block ${scrollDistance > 0 ? "badge-marquee" : ""}`}
        style={
          scrollDistance > 0
            ? ({ "--badge-marquee-distance": `${scrollDistance}px` } as React.CSSProperties)
            : undefined
        }
      >
        {label}
      </span>
    </span>
  );
}

export function ActiveTodoBadge({ todo }: { todo?: UIActiveTodo }) {
  if (!todo) return null;
  const label = todo.activeForm ?? todo.subject;
  const dotState = todo.status === "in_progress" ? "running" : "idle";

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden font-mono text-[10px] leading-none text-muted sm:text-xs">
      <AgentEyes
        state={activityEyeState(dotState)}
        size={12}
        className={activityEyeTone(dotState)}
      />
      <ScrollingLabel label={label} />
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
      className="flex min-w-0 max-w-[35%] shrink-0 items-center gap-1.5 overflow-hidden font-mono text-[10px] leading-none text-faint sm:max-w-[40%] sm:text-xs"
      title={gitBranch}
    >
      {/* nf-oct-git_branch */}
      <span className="shrink-0" aria-hidden>
        &#xf418;
      </span>
      <ScrollingLabel label={gitBranch} />
    </span>
  );
}

/** ~/a/b/project → "project" (basename, like zentui's basename path mode) */
function projectLabel(cwd?: string): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? cwd) : cwd;
}
