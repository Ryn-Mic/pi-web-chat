import {
  type TokensResult,
} from "shiki/core";
import type { BundledLanguage, CodeHighlighterPlugin } from "streamdown";

const THEMES = ["github-light", "github-dark"] as const;
const MAX_CACHED_RESULTS = 48;

export const supportedLanguages = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "shellscript",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];
const supportedLanguageSet = new Set<string>(supportedLanguages);

const aliases: Record<string, SupportedLanguage> = {
  "c++": "typescript",
  cjs: "javascript",
  console: "shellscript",
  dockerfile: "bash",
  htm: "html",
  js: "javascript",
  jsx: "tsx",
  md: "markdown",
  node: "javascript",
  py: "python",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  yml: "yaml",
  zsh: "shellscript",
};

const resultCache = new Map<string, TokensResult>();
const pendingCallbacks = new Map<string, Set<(result: TokensResult) => void>>();

function normalizeLanguage(language: string): SupportedLanguage | null {
  const normalized = language.trim().toLowerCase();
  if (supportedLanguageSet.has(normalized)) return normalized as SupportedLanguage;
  return aliases[normalized] ?? null;
}

function cacheKey(code: string, language: SupportedLanguage): string {
  return `${language}\u0000${code}`;
}

function rememberResult(key: string, result: TokensResult) {
  resultCache.delete(key);
  resultCache.set(key, result);
  if (resultCache.size > MAX_CACHED_RESULTS) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
}

async function tokenize(code: string, language: SupportedLanguage): Promise<TokensResult> {
  // Keep Shiki's engine out of the initial chat bundle. It is fetched only if
  // a supported fenced code block is actually rendered.
  const { tokenizeCode } = await import("./streamdownShiki");
  return tokenizeCode(code, language);
}

const codeHighlighter: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => supportedLanguages as unknown as BundledLanguage[],
  getThemes: () => THEMES as unknown as ReturnType<CodeHighlighterPlugin["getThemes"]>,
  supportsLanguage: (language) => normalizeLanguage(language) !== null,
  highlight: ({ code, language }, callback) => {
    const supportedLanguage = normalizeLanguage(language);
    if (!supportedLanguage) return null;

    const key = cacheKey(code, supportedLanguage);
    const cached = resultCache.get(key);
    if (cached) return cached;

    if (!callback) return null;
    const callbacks = pendingCallbacks.get(key);
    if (callbacks) {
      callbacks.add(callback);
      return null;
    }

    pendingCallbacks.set(key, new Set([callback]));
    void tokenize(code, supportedLanguage)
      .then((result) => {
        rememberResult(key, result);
        pendingCallbacks.get(key)?.forEach((notify) => notify(result));
      })
      .catch((error) => {
        console.warn("[pi-web-chat] code highlighting failed", error);
      })
      .finally(() => pendingCallbacks.delete(key));
    return null;
  },
};

export const streamdownPlugins = { code: codeHighlighter };
