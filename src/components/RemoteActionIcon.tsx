import { MorphIcon } from "morphicons/react";
import { MORPH_ICON_PATHS, type MorphActionMode } from "../lib/morph-icons";

/** Morphs the remote composer action without unmounting between transport states. */
export function RemoteActionIcon({
  mode,
  size = 20,
  className = "",
}: {
  mode: MorphActionMode;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS[mode]}
      size={size}
      strokeWidth={2.2}
      spring="snappy"
      reducedMotion="user"
      className={`remote-action-icon ${mode === "pending" ? "remote-action-icon--pending" : ""} ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}
