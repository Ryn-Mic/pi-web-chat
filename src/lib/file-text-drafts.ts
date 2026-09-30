import { getAuthStatus, getSessionCacheScope, subscribeAuthChanges } from "./auth";
import type { TextFileSnapshot } from "./file-text-api";

export interface TextFileDraft {
  source: TextFileSnapshot;
  text: string;
}

const drafts = new Map<string, TextFileDraft>();
let owner: string | null = null;
let warningRegistered = false;

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (owner !== getSessionCacheScope() || drafts.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
}

function syncUnloadWarning(): void {
  if (typeof window === "undefined") return;
  if (drafts.size > 0 && !warningRegistered) {
    window.addEventListener("beforeunload", warnBeforeUnload);
    warningRegistered = true;
  } else if (drafts.size === 0 && warningRegistered) {
    window.removeEventListener("beforeunload", warnBeforeUnload);
    warningRegistered = false;
  }
}

subscribeAuthChanges(() => {
  if (drafts.size > 0 && (getAuthStatus() === "unauthenticated" || owner !== getSessionCacheScope())) {
    drafts.clear();
    owner = null;
    syncUnloadWarning();
  }
});

function identity(cwd: string, path: string, workspaceKey: string): string {
  const session = getSessionCacheScope();
  if (owner !== session) {
    drafts.clear();
    owner = session;
    syncUnloadWarning();
  }
  return JSON.stringify([workspaceKey, cwd, path]);
}

export function editorText(source: string): string {
  return source.replace(/^\uFEFF/, "").replace(/\r\n?|\n/g, "\n");
}

/** Keep the original BOM and consistent CRLF convention when editing in a textarea. */
export function sourceText(text: string, original: string): string {
  const crlf = original.includes("\r\n") && !/(^|[^\r])\n/.test(original);
  const newline = crlf ? "\r\n" : original.includes("\r") && !original.includes("\n") ? "\r" : "\n";
  return (original.startsWith("\uFEFF") ? "\uFEFF" : "") + text.replace(/\n/g, newline);
}

export function getTextFileDraft(cwd: string, path: string, workspaceKey: string): TextFileDraft | undefined {
  return drafts.get(identity(cwd, path, workspaceKey));
}

export function setTextFileDraft(cwd: string, path: string, draft: TextFileDraft, workspaceKey: string): void {
  const key = identity(cwd, path, workspaceKey);
  if (draft.text === editorText(draft.source.text)) drafts.delete(key);
  else drafts.set(key, draft);
  syncUnloadWarning();
}

export function discardTextFileDraft(cwd: string, path: string, workspaceKey: string): void {
  drafts.delete(identity(cwd, path, workspaceKey));
  syncUnloadWarning();
}

export function confirmDiscardTextFileDraft(cwd: string, path: string, message: string, workspaceKey: string): boolean {
  if (!getTextFileDraft(cwd, path, workspaceKey)) return true;
  if (!window.confirm(message)) return false;
  discardTextFileDraft(cwd, path, workspaceKey);
  return true;
}

export function discardWorkspaceTextDrafts(workspaceKey: string): void {
  identity("", "", workspaceKey);
  const keys = [...drafts.keys()].filter((key) => (JSON.parse(key) as string[])[0] === workspaceKey);
  for (const key of keys) drafts.delete(key);
  syncUnloadWarning();
}

export function confirmDiscardWorkspaceTextDrafts(workspaceKey: string, message: string, discard = true): boolean {
  identity("", "", workspaceKey);
  const keys = [...drafts.keys()].filter((key) => (JSON.parse(key) as string[])[0] === workspaceKey);
  if (keys.length === 0) return true;
  if (!window.confirm(message)) return false;
  if (discard) discardWorkspaceTextDrafts(workspaceKey);
  return true;
}

export function mergeTextFileDrafts(losingKey: string, survivingKey: string): void {
  if (losingKey === survivingKey) return;
  for (const [key, draft] of drafts) {
    const [workspaceKey, cwd, path] = JSON.parse(key) as [string, string, string];
    if (workspaceKey !== losingKey) continue;
    const destination = identity(cwd, path, survivingKey);
    if (!drafts.has(destination)) drafts.set(destination, draft);
    drafts.delete(key);
  }
}
