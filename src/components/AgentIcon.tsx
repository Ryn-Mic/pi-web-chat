import type { UIAgentKind } from "../../shared/protocol";

/**
 * Agent identity badge. pi and Codex share the same animated eye expressions,
 * so a small per-agent glyph supplies the visual distinction: a π chip for pi
 * (theme accent) and a ⌘ chip for Codex (amber). The badge tints with
 * currentColor like AgentEyes, so callers choose the tone via a text-* class.
 */
export function AgentIcon({
  agent,
  size = 16,
  className = "",
  title,
}: {
  agent: UIAgentKind;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`agent-icon shrink-0 ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <rect
        x="0.75"
        y="0.75"
        width="22.5"
        height="22.5"
        rx="6"
        className="agent-icon__badge"
        aria-hidden
      />
      <text
        x="12"
        y="13.25"
        textAnchor="middle"
        dominantBaseline="central"
        className="agent-icon__glyph"
        aria-hidden
      >
        {agent === "codex" ? "⌘" : "π"}
      </text>
    </svg>
  );
}
