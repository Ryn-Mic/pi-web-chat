import { useEffect, useState } from "react";
import { MorphIcon } from "morphicons/react";
import { MORPH_ICON_PATHS } from "../lib/morph-icons";

/** Navigation and message actions share centralized paths and motion preferences. */
export function NavigationActionIcon({
  direction,
  size = 16,
  className = "",
}: {
  direction: "back" | "down" | "reuse";
  size?: number;
  className?: string;
}) {
  const path = direction === "back" ? "chevronLeft" : direction === "down" ? "arrowDown" : "reuse";
  return (
    <MorphIcon icon={MORPH_ICON_PATHS[path]} size={size} strokeWidth={2}
      spring="snappy" reducedMotion="user" className={`shrink-0 ${className}`} aria-hidden focusable="false" />
  );
}

export function StarterPromptIcon({ kind }: { kind: "search" | "git" | "tests" | "performance" }) {
  const path = kind === "search" ? "search" : kind === "git" ? "gitBranch" : kind === "tests" ? "check" : "sparkle";
  return (
    <MorphIcon icon={MORPH_ICON_PATHS[path]} size={17} strokeWidth={1.8}
      spring="snappy" reducedMotion="user" className="shrink-0 text-accent" aria-hidden focusable="false" />
  );
}

/** Settings trigger icon that smoothly morphs between gear and close state */
export function SettingsTriggerIcon({
  open = false,
  size = 20,
  className = "",
}: {
  open?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={open ? MORPH_ICON_PATHS.close : MORPH_ICON_PATHS.settings}
      size={size}
      strokeWidth={1.9}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 transition-transform ${open ? "rotate-90" : ""} ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Sidebar toggle icon morphing between collapsed and expanded panel */
export function SidebarToggleIcon({
  open = false,
  size = 18,
  className = "",
}: {
  open?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={open ? MORPH_ICON_PATHS.panelLeftClose : MORPH_ICON_PATHS.panelLeft}
      size={size}
      strokeWidth={1.8}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Document / text file icon */
export function FileItemIcon({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.fileText}
      size={size}
      strokeWidth={1.7}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 text-faint ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** File directory folder icon that smoothly morphs between closed and open state */
export function FolderTreeIcon({
  open = false,
  size = 14,
  className = "",
}: {
  open?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={open ? MORPH_ICON_PATHS.folderOpen : MORPH_ICON_PATHS.folderClosed}
      size={size}
      strokeWidth={1.7}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 text-amber-500/80 dark:text-amber-400/80 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Chevron icon morphing smoothly between right and down */
export function TreeChevronIcon({
  expanded = false,
  size = 12,
  className = "",
}: {
  expanded?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={expanded ? MORPH_ICON_PATHS.chevronDown : MORPH_ICON_PATHS.chevronRight}
      size={size}
      strokeWidth={2.2}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** New session icon with tactile spring morph feedback on click */
export function NewSessionIcon({
  size = 18,
  className = "",
  burstToken = 0,
}: {
  size?: number;
  className?: string;
  burstToken?: number;
}) {
  const [sparking, setSparking] = useState(false);

  useEffect(() => {
    if (!burstToken) return;
    setSparking(true);
    const timer = window.setTimeout(() => setSparking(false), 550);
    return () => window.clearTimeout(timer);
  }, [burstToken]);

  return (
    <MorphIcon
      icon={sparking ? MORPH_ICON_PATHS.sparkle : MORPH_ICON_PATHS.plus}
      size={size}
      strokeWidth={sparking ? 2.1 : 1.9}
      spring="bouncy"
      reducedMotion="user"
      className={`shrink-0 ${sparking ? "scale-110 text-accent" : ""} ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Refresh button icon with continuous spring spin and settle */
export function RefreshActionIcon({
  refreshing = false,
  size = 16,
  className = "",
}: {
  refreshing?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.refresh}
      size={size}
      strokeWidth={1.8}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${refreshing ? "refresh-action-icon--spinning" : "transition-transform active:rotate-180"} ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Copy feedback icon morphing smoothly between clipboard and checkmark */
export function CopyActionIcon({
  copied = false,
  size = 14,
  className = "",
}: {
  copied?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={copied ? MORPH_ICON_PATHS.check : MORPH_ICON_PATHS.copy}
      size={size}
      strokeWidth={copied ? 2.3 : 1.8}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${copied ? "text-emerald-500 scale-105" : ""} ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Pencil icon for rename actions in list rows */
export function RenameActionIcon({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.edit}
      size={size}
      strokeWidth={1.8}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Trash icon for delete actions in list rows */
export function DeleteActionIcon({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.trash}
      size={size}
      strokeWidth={1.8}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Checkmark icon confirming a destructive action */
export function ConfirmActionIcon({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.check}
      size={size}
      strokeWidth={2.2}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Cross icon dismissing a destructive action */
export function DismissActionIcon({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.close}
      size={size}
      strokeWidth={2.2}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}

/** Magnifier icon for search fields */
export function SearchFieldIcon({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <MorphIcon
      icon={MORPH_ICON_PATHS.search}
      size={size}
      strokeWidth={2}
      spring="snappy"
      reducedMotion="user"
      className={`shrink-0 ${className}`}
      aria-hidden
      focusable="false"
    />
  );
}
