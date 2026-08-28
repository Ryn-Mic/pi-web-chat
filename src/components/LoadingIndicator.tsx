import { AgentEyes } from "./AgentEyes";

type LoadingSize = "sm" | "md" | "lg";

const sizePx: Record<LoadingSize, number> = {
  sm: 14,
  md: 18,
  lg: 30,
};

/** A restrained token-based loader for panels, actions, and full-page waits. */
export function LoadingIndicator({
  label,
  size = "md",
  showLabel = false,
  className = "",
}: {
  label: string;
  size?: LoadingSize;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`inline-flex items-center gap-2 text-muted ${className}`}
    >
      <AgentEyes state="loading" size={sizePx[size]} className="shrink-0" />
      {showLabel ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
