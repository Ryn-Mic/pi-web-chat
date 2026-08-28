import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const GIT_COMMAND_TIMEOUT_MS = 3_000;
export const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: "not-repository" | "invalid" | "failed" = "failed",
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitFileStatus {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface GitStatus {
  root: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
  conflicted: GitFileStatus[];
  isDirty: boolean;
}

export interface GitBranch {
  name: string;
  commit: string;
  upstream: string | null;
  current: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export interface GitCommitDetail extends GitCommit {
  files: GitCommitFile[];
  diff: string;
}

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: string;
}

export interface GitDiff {
  path: string;
  diff: string;
}

function runGit(cwd: string, args: string[], allowExitCodes: number[] = []): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { status?: number; stderr?: string };
    if (typeof result.status === "number" && allowExitCodes.includes(result.status)) {
      return String((result as { stdout?: string }).stdout ?? "");
    }
    const message = String(result.stderr ?? result.message ?? "git command failed").trim();
    if (/not a git repository|cannot change to|does not exist/i.test(message)) {
      throw new GitCommandError("not a git repository", "not-repository");
    }
    throw new GitCommandError(message.slice(0, 500) || "git command failed");
  }
}

export function assertGitRoot(cwd: string): string {
  const root = resolve(cwd);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new GitCommandError("project directory does not exist", "invalid");
  }
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"]).trim();
  if (!gitRoot) throw new GitCommandError("not a git repository", "not-repository");
  return resolve(gitRoot);
}

function classify(index: string, worktree: string): GitFileStatus["kind"] {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "U" || worktree === "U" || (index === "A" && worktree === "A")) return "conflicted";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "A" || worktree === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
}

export function parseGitStatus(output: string, root: string): GitStatus {
  const records = output.split("\0").filter(Boolean);
  const header = records.shift() ?? "";
  const branchMatch = header.match(/^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
  const rawBranch = branchMatch?.[1] ?? "";
  const unbornBranch = rawBranch.match(/^No commits yet on (.+)$/)?.[1];
  const branch = rawBranch === "HEAD (no branch)" ? null : (unbornBranch ?? rawBranch) || null;
  const upstream = branchMatch?.[2] ?? null;
  let ahead = 0;
  let behind = 0;
  const tracking = branchMatch?.[3] ?? "";
  const aheadMatch = tracking.match(/ahead (\d+)/);
  const behindMatch = tracking.match(/behind (\d+)/);
  if (aheadMatch) ahead = Number(aheadMatch[1]);
  if (behindMatch) behind = Number(behindMatch[1]);

  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: GitFileStatus[] = [];
  const conflicted: GitFileStatus[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    if (record.length < 4) continue;
    const index = record[0] ?? " ";
    const worktree = record[1] ?? " ";
    const path = record.slice(3);
    const item: GitFileStatus = { path, index, worktree, kind: classify(index, worktree) };
    if (index === "R" || worktree === "R") {
      const oldPath = records[++i];
      if (oldPath) item.oldPath = oldPath;
    }
    if (item.kind === "untracked") {
      untracked.push(item);
    } else if (item.kind === "conflicted") {
      conflicted.push(item);
    } else {
      if (index !== " ") staged.push(item);
      if (worktree !== " ") unstaged.push(item);
    }
  }
  const isDirty = staged.length > 0 || unstaged.length > 0 || untracked.length > 0 || conflicted.length > 0;
  return { root, branch, head: null, upstream, ahead, behind, staged, unstaged, untracked, conflicted, isDirty };
}

export function getGitStatus(cwd: string): GitStatus {
  const workingCwd = resolve(cwd);
  const root = assertGitRoot(workingCwd);
  const status = parseGitStatus(runGit(workingCwd, ["status", "--porcelain=v1", "-z", "-b", "--", "."]), root);
  let head: string | null = null;
  try {
    head = runGit(workingCwd, ["rev-parse", "HEAD"]).trim() || null;
  } catch (error) {
    if (!(error instanceof GitCommandError) || !/unknown revision|does not have any commits/i.test(error.message)) throw error;
  }
  return { ...status, head };
}

export function getGitBranches(cwd: string): GitBranch[] {
  const root = assertGitRoot(cwd);
  const output = runGit(root, ["for-each-ref", "--sort=refname", "--format=%(HEAD)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)", "refs/heads"]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [marker, name, commit, upstream] = line.split("\0");
    return { current: marker === "*", name: name ?? "", commit: commit ?? "", upstream: upstream || null };
  });
}

function parseCommitRecord(record: string): GitCommit {
  const [hash, shortHash, author, email, date, subject, ...body] = record.split("\0");
  return { hash: hash ?? "", shortHash: shortHash ?? "", author: author ?? "", email: email ?? "", date: date ?? "", subject: subject ?? "", body: body.join("\0").trim() };
}

export function getGitLog(cwd: string, limit = 50): GitCommit[] {
  const root = assertGitRoot(cwd);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const separator = "--GIT-WEB-COMMIT--";
  const format = `--format=${separator}%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b`;
  try {
    const output = runGit(root, ["log", `-${safeLimit}`, "--date=iso-strict", format]);
    return output.split(separator).filter(Boolean).map(parseCommitRecord);
  } catch (error) {
    if (error instanceof GitCommandError && /does not have any commits|unknown revision/i.test(error.message)) return [];
    throw error;
  }
}

export function getGitCommit(cwd: string, hash: string): GitCommitDetail {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new GitCommandError("invalid commit hash", "invalid");
  const root = assertGitRoot(cwd);
  const separator = "--GIT-WEB-COMMIT--";
  const format = `--format=${separator}%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b`;
  const output = runGit(root, ["show", "-s", format, hash]);
  const commit = parseCommitRecord(output.split(separator).filter(Boolean)[0] ?? "");
  const diff = runGit(root, ["show", "--format=", "--no-color", "--no-ext-diff", hash]);
  const filesOutput = runGit(root, ["show", "--format=", "--name-status", "--find-renames", hash]);
  const files = filesOutput.split("\n").filter(Boolean).map((line) => {
    const [status, first, second] = line.split("\t");
    return second ? { status: status ?? "", oldPath: first, path: second } : { status: status ?? "", path: first ?? "" };
  });
  return { ...commit, files, diff };
}

export function getGitDiff(cwd: string, path: string, staged = false): GitDiff {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new GitCommandError("invalid file path", "invalid");
  const workingCwd = resolve(cwd);
  assertGitRoot(workingCwd);
  const args = staged ? ["diff", "--no-color", "--no-ext-diff", "--cached", "--", path] : ["diff", "--no-color", "--no-ext-diff", "--", path];
  return { path, diff: runGit(workingCwd, args) };
}

export function checkoutGitBranch(cwd: string, branch: string): GitStatus {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new GitCommandError("invalid branch name", "invalid");
  }
  const root = assertGitRoot(cwd);
  if (runGit(root, ["status", "--porcelain=v1"]).trim()) {
    throw new GitCommandError("working tree has uncommitted changes", "invalid");
  }
  if (!getGitBranches(root).some((item) => item.name === branch)) throw new GitCommandError("local branch not found", "invalid");
  runGit(root, ["switch", "--quiet", "--no-guess", branch]);
  return getGitStatus(root);
}

