type LoadingSize = "sm" | "md" | "lg";

const sizeClass: Record<LoadingSize, string> = {
  sm: "size-3",
  md: "size-4",
  lg: "size-7",
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
      <span className={`loading-indicator__orbital shrink-0 ${sizeClass[size]}`} aria-hidden />
      {showLabel ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
