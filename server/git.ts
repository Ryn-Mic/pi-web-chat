import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const execGit = promisify(execFile);

export const GIT_COMMAND_TIMEOUT_MS = 3_000;
export const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;

/**
 * Current branch read straight from `.git/HEAD`.
 *
 * `git branch --show-current` costs ~6ms of blocked event loop (measured) and
 * this value is needed on every snapshot build, so the common case reads a tiny
 * file instead. Returns `undefined` when HEAD cannot be read directly (bare
 * repository, unusual layout, missing directory) so the caller can fall back to
 * git, and `null` for a detached HEAD — the same answer `--show-current` gives.
 */
export function branchFromHeadFile(cwd: string): string | null | undefined {
  try {
    const dotGit = join(cwd, ".git");
    let gitDir = dotGit;
    if (!statSync(dotGit).isDirectory()) {
      // Worktrees and submodules keep a gitfile pointing at the real git dir.
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      const target = match?.[1]?.trim();
      if (!target) return undefined;
      gitDir = isAbsolute(target) ? target : resolve(cwd, target);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref?.[1] ? ref[1].trim() : null;
  } catch {
    return undefined;
  }
}

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

async function runGit(cwd: string, args: string[], allowExitCodes: number[] = []): Promise<string> {
  try {
    const { stdout } = await execGit("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT,
    });
    return stdout;
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { code?: number; stderr?: string };
    if (typeof result.code === "number" && allowExitCodes.includes(result.code)) {
      return String((result as { stdout?: string }).stdout ?? "");
    }
    const message = String(result.stderr ?? result.message ?? "git command failed").trim();
    if (/not a git repository|cannot change to|does not exist/i.test(message)) {
      throw new GitCommandError("not a git repository", "not-repository");
    }
    throw new GitCommandError(message.slice(0, 500) || "git command failed");
  }
}

export async function assertGitRoot(cwd: string): Promise<string> {
  const root = resolve(cwd);
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new GitCommandError("project directory does not exist", "invalid");
  }
  const gitRoot = (await runGit(root, ["rev-parse", "--show-toplevel"])).trim();
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

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const workingCwd = await realpath(cwd);
  const root = await assertGitRoot(workingCwd);
  const status = parseGitStatus(await runGit(workingCwd, ["status", "--porcelain=v1", "-z", "-b", "--", "."]), root);
  const seen = new Set<GitFileStatus>();
  for (const files of [status.staged, status.unstaged, status.untracked, status.conflicted]) {
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      file.path = relative(workingCwd, resolve(root, file.path));
      if (file.oldPath) file.oldPath = relative(workingCwd, resolve(root, file.oldPath));
    }
  }
  let head: string | null = null;
  try {
    head = (await runGit(workingCwd, ["rev-parse", "HEAD"])).trim() || null;
  } catch (error) {
    if (!(error instanceof GitCommandError) || !/unknown revision|does not have any commits/i.test(error.message)) throw error;
  }
  return { ...status, head };
}

export async function getGitBranches(cwd: string): Promise<GitBranch[]> {
  const root = await assertGitRoot(cwd);
  const output = await runGit(root, ["for-each-ref", "--sort=refname", "--format=%(HEAD)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)", "refs/heads"]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [marker, name, commit, upstream] = line.split("\0");
    return { current: marker === "*", name: name ?? "", commit: commit ?? "", upstream: upstream || null };
  });
}

function parseCommitRecord(record: string): GitCommit {
  const [hash, shortHash, author, email, date, subject, ...body] = record.split("\0");
  return { hash: hash ?? "", shortHash: shortHash ?? "", author: author ?? "", email: email ?? "", date: date ?? "", subject: subject ?? "", body: body.join("\0").trim() };
}

export async function getGitLog(cwd: string, limit = 50): Promise<GitCommit[]> {
  const root = await assertGitRoot(cwd);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
  const separator = "--GIT-WEB-COMMIT--";
  const format = `--format=${separator}%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b`;
  try {
    const output = await runGit(root, ["log", `-${safeLimit}`, "--date=iso-strict", format]);
    return output.split(separator).filter(Boolean).map(parseCommitRecord);
  } catch (error) {
    if (error instanceof GitCommandError && /does not have any commits|unknown revision/i.test(error.message)) return [];
    throw error;
  }
}

export async function getGitCommit(cwd: string, hash: string): Promise<GitCommitDetail> {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new GitCommandError("invalid commit hash", "invalid");
  const root = await assertGitRoot(cwd);
  const workingCwd = await realpath(cwd);
  const separator = "--GIT-WEB-COMMIT--";
  const format = `--format=${separator}%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b`;
  const output = await runGit(root, ["show", "-s", format, hash]);
  const commit = parseCommitRecord(output.split(separator).filter(Boolean)[0] ?? "");
  const diff = await runGit(workingCwd, ["show", "--format=", "--no-color", "--no-ext-diff", hash, "--", "."]);
  const filesOutput = await runGit(workingCwd, ["show", "--format=", "--name-status", "-z", "--find-renames", hash, "--", "."]);
  const records = filesOutput.split("\0").filter(Boolean);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < records.length;) {
    const status = records[i++]!;
    const first = records[i++];
    if (!first) break;
    if (/^[RC]/.test(status)) {
      const second = records[i++];
      if (second) files.push({ status, oldPath: relative(workingCwd, resolve(root, first)), path: relative(workingCwd, resolve(root, second)) });
    } else files.push({ status, path: relative(workingCwd, resolve(root, first)) });
  }
  return { ...commit, files, diff };
}

export async function getGitDiff(cwd: string, path: string, staged = false): Promise<GitDiff> {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new GitCommandError("invalid file path", "invalid");
  const workingCwd = await realpath(cwd);
  await assertGitRoot(workingCwd);
  const args = staged ? ["diff", "--no-color", "--no-ext-diff", "--cached", "--", path] : ["diff", "--no-color", "--no-ext-diff", "--", path];
  return { path, diff: await runGit(workingCwd, args) };
}

export async function checkoutGitBranch(cwd: string, branch: string): Promise<GitStatus> {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new GitCommandError("invalid branch name", "invalid");
  }
  const root = await assertGitRoot(cwd);
  if ((await runGit(root, ["status", "--porcelain=v1"])).trim()) {
    throw new GitCommandError("working tree has uncommitted changes", "invalid");
  }
  if (!(await getGitBranches(root)).some((item) => item.name === branch)) throw new GitCommandError("local branch not found", "invalid");
  await runGit(root, ["switch", "--quiet", "--no-guess", branch]);
  return getGitStatus(cwd);
}

