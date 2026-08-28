import { createHighlighterCore, type TokensResult } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { SupportedLanguage } from "./streamdownCode";

const languageLoaders = {
  bash: () => import("@shikijs/langs/bash"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
} satisfies Record<SupportedLanguage, () => Promise<{ default: unknown }>>;

const highlighterPromise = createHighlighterCore({
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  themes: [githubLight, githubDark],
});
const loadedLanguages = new Set<SupportedLanguage>();

export async function tokenizeCode(
  code: string,
  language: SupportedLanguage,
): Promise<TokensResult> {
  const highlighter = await highlighterPromise;
  if (!loadedLanguages.has(language)) {
    const module = await languageLoaders[language]();
    await highlighter.loadLanguage(module.default as never);
    loadedLanguages.add(language);
  }
  return highlighter.codeToTokens(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
  });
}
