import type { UICommandInfo } from "../shared/protocol.ts";
import type { CodexReviewTarget } from "./codex.ts";

/** Web-supported Codex commands. TUI-only and destructive commands stay hidden. */
export const CODEX_COMMANDS: UICommandInfo[] = [
  { name: "settings", description: "Open web settings", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Browse saved sessions", source: "builtin" },
  { name: "fork", description: "Fork the current native Codex thread", source: "builtin" },
  { name: "copy", description: "Copy the last assistant message", source: "builtin" },
  { name: "diff", description: "Open the Git diff workspace", source: "builtin" },
  { name: "model", description: "Select or set the Codex model", source: "builtin", argumentHint: "[model]" },
  { name: "reasoning", description: "Select or set the reasoning effort", source: "builtin", argumentHint: "[level]" },
  { name: "rename", description: "Rename the current Codex thread", source: "builtin", argumentHint: "<name>" },
  { name: "status", description: "Show the current Codex session status", source: "builtin" },
  { name: "compact", description: "Compact the current Codex context", source: "builtin" },
  {
    name: "review",
    description: "Review uncommitted changes, a base branch, a commit, or custom instructions",
    source: "builtin",
    argumentHint: "[--base <branch>|--commit <sha>|instructions]",
  },
];

export type CodexReviewTargetResult =
  | { ok: true; target: CodexReviewTarget; error?: never }
  | { ok: false; target?: never; error: string };

/** Parse the Web command syntax into the app-server's structured review target. */
export function parseCodexReviewTarget(args: string): CodexReviewTargetResult {
  const value = args.trim();
  if (!value) return { ok: true, target: { type: "uncommittedChanges" } };

  const base = /^--base\s+(\S+)\s*$/.exec(value);
  if (base) return { ok: true, target: { type: "baseBranch", branch: base[1]! } };
  if (value.startsWith("--base")) {
    return { ok: false, error: "Use /review --base <branch>." };
  }

  const commit = /^--commit\s+(\S+)\s*$/.exec(value);
  if (commit) return { ok: true, target: { type: "commit", sha: commit[1]!, title: null } };
  if (value.startsWith("--commit")) {
    return { ok: false, error: "Use /review --commit <sha>." };
  }

  if (value.startsWith("--")) {
    return { ok: false, error: "Use /review, /review --base <branch>, /review --commit <sha>, or /review <instructions>." };
  }
  return { ok: true, target: { type: "custom", instructions: value } };
}
