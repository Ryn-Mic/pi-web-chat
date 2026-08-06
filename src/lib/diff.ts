/** Line-level LCS diff — for converting edit tool args (oldText/newText) to a unified diff */

export interface DiffOp {
  type: "add" | "del" | "keep";
  text: string;
}

/** Diff two line arrays into ops (del/add order guaranteed, first string as base) */
export function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1]! + 1 : Math.max(dp[i + 1][j]!, dp[i][j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "keep", text: a[i]! });
      i++;
      j++;
    } else if ((dp[i + 1][j] ?? 0) >= (dp[i][j + 1] ?? 0)) {
      ops.push({ type: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: a[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j]! });
    j++;
  }
  return ops;
}

export interface EditReplacement {
  oldText: string;
  newText: string;
}

export interface EditArgs {
  path: string;
  edits: EditReplacement[];
}

/**
 * Extract the file path + replacements from pi SDK edit tool args.
 * - Canonical: { path, edits: [{oldText, newText}] }
 * - legacy: { file_path | file, oldText, newText } (single top-level replacement)
 *
 * Returns null when the arg shape doesn't match at all (falls back to plain args).
 */
export function parseEditArgs(args: unknown): EditArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const path =
    typeof a.path === "string"
      ? a.path
      : typeof a.file_path === "string"
        ? a.file_path
        : typeof a.file === "string"
          ? a.file
          : null;
  if (!path) return null;

  const edits: EditReplacement[] = [];
  if (Array.isArray(a.edits)) {
    for (const e of a.edits) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as EditReplacement).oldText === "string" &&
        typeof (e as EditReplacement).newText === "string"
      ) {
        edits.push({
          oldText: (e as EditReplacement).oldText,
          newText: (e as EditReplacement).newText,
        });
      }
    }
  }
  // legacy single-replacement shape
  if (edits.length === 0 && typeof a.oldText === "string" && typeof a.newText === "string") {
    edits.push({ oldText: a.oldText, newText: a.newText });
  }

  return edits.length > 0 ? { path, edits } : null;
}

/**
 * Edit tool args → git-diff-style string.
 * One header (---/+++) per file, one hunk (@@) per replacement.
 */
export function buildEditDiffFromArgs(args: unknown): { path: string; diff: string } | null {
  const parsed = parseEditArgs(args);
  if (!parsed) return null;
  const { path, edits } = parsed;

  const lines: string[] = [];
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  for (const e of edits) {
    const a = e.oldText.split("\n");
    const b = e.newText.split("\n");
    // The real change location is unknown, so the hunk range covers the whole file
    lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
    for (const op of lineDiff(a, b)) {
      if (op.type === "keep") lines.push(" " + op.text);
      else if (op.type === "add") lines.push("+" + op.text);
      else lines.push("-" + op.text);
    }
  }
  return { path, diff: lines.join("\n") };
}

export type DiffLineKind =
  | "header"
  | "hunk"
  | "add"
  | "del"
  | "context"
  | "nonewline"
  | "plain";

/** One diff line: kind + old/new line numbers (null when absent) */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function parseDiff(text: string): DiffLine[] {
  let oldNo = 0;
  let newNo = 0;
  const out: DiffLine[] = [];
  for (const line of text.split("\n")) {
    if (/^@@ /.test(line)) {
      // @@ -a,b +c,d @@
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      out.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) {
      out.push({ kind: "header", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (/^\\ No newline/.test(line)) {
      out.push({ kind: "nonewline", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: line, oldNo: null, newNo: newNo || null });
      if (newNo) newNo++;
      continue;
    }
    if (line.startsWith("-")) {
      out.push({ kind: "del", text: line, oldNo: oldNo || null, newNo: null });
      if (oldNo) oldNo++;
      continue;
    }
    if (line.startsWith(" ")) {
      out.push({
        kind: "context",
        text: line,
        oldNo: oldNo || null,
        newNo: newNo || null,
      });
      if (oldNo) oldNo++;
      if (newNo) newNo++;
      continue;
    }
    out.push({ kind: "plain", text: line, oldNo: null, newNo: null });
  }
  return out;
}

/** Whether the text looks like a unified diff (diff headers or enough +/- lines) */
export function isUnifiedDiff(text: string): boolean {
  if (!text.includes("\n")) return false;
  if (/^(diff --git |@@ -|--- [ab]\/|\+\+\+ [ab]\/)/m.test(text)) return true;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.filter((l) => /^[+-]/.test(l)).length >= 3;
}
