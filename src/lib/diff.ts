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
 * Render ops as compact unified-diff hunk lines: only the changed regions
 * plus CONTEXT unchanged lines around each, with accurate old/new line
 * numbers. Returns null when there are no changes.
 */
function compactDiffLines(
  ops: DiffOp[],
  context = 2,
): string[] | null {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "keep") changes.push(i);
  }
  if (changes.length === 0) return null;

  // Merge change clusters that are close enough that their context windows overlap
  const segs: Array<[number, number]> = [];
  let s = changes[0]!;
  let e = changes[0]!;
  for (let i = 1; i < changes.length; i++) {
    if (changes[i]! - e <= context * 2 + 1) e = changes[i]!;
    else {
      segs.push([s, e]);
      s = e = changes[i]!;
    }
  }
  segs.push([s, e]);

  const out: string[] = [];
  for (const [segStart, segEnd] of segs) {
    const start = Math.max(0, segStart - context);
    const end = Math.min(ops.length - 1, segEnd + context);
    if (out.length > 0) out.push("…"); // omitted lines between hunks

    // Old/new line numbers at `start`
    let oldNo = 1;
    let newNo = 1;
    for (let i = 0; i < start; i++) {
      const t = ops[i]!.type;
      if (t !== "add") oldNo++;
      if (t !== "del") newNo++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i++) {
      if (ops[i]!.type !== "add") oldCount++;
      if (ops[i]!.type !== "del") newCount++;
    }
    out.push(`@@ -${oldNo},${oldCount} +${newNo},${newCount} @@`);
    for (let i = start; i <= end; i++) {
      const op = ops[i]!;
      if (op.type === "keep") out.push(" " + op.text);
      else if (op.type === "add") out.push("+" + op.text);
      else out.push("-" + op.text);
    }
  }
  return out;
}

/**
 * Edit tool args → git-diff-style string.
 * One header (---/+++) per file, one compact hunk (@@) per replacement.
 */
export function buildEditDiffFromArgs(
  args: unknown,
): { path: string; diff: string; stats: EditDiffStats } | null {
  const parsed = parseEditArgs(args);
  if (!parsed) return null;
  const { path, edits } = parsed;

  const lines: string[] = [];
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  let added = 0;
  let deleted = 0;
  let rendered = 0;
  for (const e of edits) {
    const a = e.oldText.split("\n");
    const b = e.newText.split("\n");
    const ops = lineDiff(a, b);
    const compact = compactDiffLines(ops, 2);
    if (!compact) continue;
    for (const op of ops) {
      if (op.type === "add") added++;
      else if (op.type === "del") deleted++;
    }
    lines.push(...compact);
    rendered++;
  }
  if (rendered === 0) return null;
  return { path, diff: lines.join("\n"), stats: { added, deleted } };
}

export interface EditDiffStats {
  added: number;
  deleted: number;
}

export type DiffLineKind =
  | "header"
  | "hunk"
  | "add"
  | "del"
  | "context"
  | "nonewline"
  | "ellipsis"
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
    if (line === "…") {
      out.push({ kind: "ellipsis", text: line, oldNo: null, newNo: null });
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
