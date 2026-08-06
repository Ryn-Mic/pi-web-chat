/** 행 단위 LCS diff — edit 도구 인자(oldText/newText) → unified diff 로 변환용 */

export interface DiffOp {
  type: "add" | "del" | "keep";
  text: string;
}

/** 두 행 배열의 차이를 ops 로 반환 (첫 문자열을 기준으로 del/add 순서 보장) */
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
 * pi SDK edit 도구 인자에서 파일 경로 + 교체 목록을 추출.
 * - 정식: { path, edits: [{oldText, newText}] }
 * - legacy: { file_path | file, oldText, newText } (최상위 단일 교체)
 *
 * 파라미터 형태가 전혀 맞지 않으면 null (일반 args 렌더로 폴백).
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
  // legacy 단일 교체 형태
  if (edits.length === 0 && typeof a.oldText === "string" && typeof a.newText === "string") {
    edits.push({ oldText: a.oldText, newText: a.newText });
  }

  return edits.length > 0 ? { path, edits } : null;
}

/**
 * edit 도구 인자 → git diff 스타일 문자열.
 * 파일당 한 번 헤더(---/+++), 교체별 한 hunk(@@)를 만든다.
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
    // 실제 변경 위치를 알 수 없으므로 hunk 범위는 전체 파일 기준
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

/** diff 한 줄: 종류 + 구/신 행 번호 (행 번호 없으면 null) */
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

/** 텍스트가 unified diff 처럼 보이는지 (diff 헤더 또는 +- 줄이 충분히 많으면) */
export function isUnifiedDiff(text: string): boolean {
  if (!text.includes("\n")) return false;
  if (/^(diff --git |@@ -|--- [ab]\/|\+\+\+ [ab]\/)/m.test(text)) return true;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.filter((l) => /^[+-]/.test(l)).length >= 3;
}
