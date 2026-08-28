export function formatGitTimestamp(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = String(date.getFullYear() % 100).padStart(2, "0");
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${year}/${month}/${day} ${time}`;
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
