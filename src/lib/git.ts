export function formatGitTimestamp(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

/**
 * Git's patch output begins every file with a `diff --git` line. The command
 * and name-status output use the same tree order, so the returned array lines
 * up with the commit file list without exposing shell parsing to the client.
 */
export function splitCommitDiffByFile(diff: string): string[] {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "));
}
