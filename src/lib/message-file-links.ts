const FILE_LINK_PREFIX = "#pi-file:";

const FILE_EXTENSION_LIST = [
  "bash",
  "bmp",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "cxx",
  "diff",
  "doc",
  "docx",
  "env",
  "fish",
  "gif",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "md",
  "mdx",
  "mjs",
  "patch",
  "pdf",
  "php",
  "png",
  "ppt",
  "pptx",
  "proto",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "yaml",
  "yml",
  "zsh",
].sort((left, right) => right.length - left.length);
const FILE_EXTENSIONS = FILE_EXTENSION_LIST.join("|");

const FILE_TOKEN_RE = new RegExp(
  [
    String.raw`(?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_@+~.-]+\/)+[A-Za-z0-9_@+~.-]+(?:\:\d+(?:\:\d+)?|#L\d+(?:C\d+)?)?`,
    String.raw`(?:(?<![A-Za-z0-9@])\.[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z0-9_@+~-]+\.(?:${FILE_EXTENSIONS}))(?![A-Za-z0-9_-])(?:\:\d+(?:\:\d+)?|#L\d+(?:C\d+)?)?`,
  ].join("|"),
  "gi",
);
const LOCATION_SUFFIX_RE = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/i;
const STANDARD_FILENAMES = new Set([
  "dockerfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

export interface MessageFileReference {
  /** Display text, including an optional line/column suffix. */
  display: string;
  /** Project-relative path accepted by the existing preview API. */
  path: string;
  name: string;
}

export type MessageFileSegment =
  | { type: "text"; text: string }
  | { type: "file"; reference: MessageFileReference };

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?\]}]+$/, "");
}

function isFileLike(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  if (!name || /^\d+(?:\.\d+)*$/.test(name)) return false;
  if (name.startsWith(".") && name.length > 1) return true;
  if (STANDARD_FILENAMES.has(name.toLowerCase())) return true;
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() : null;
  if (extension && FILE_EXTENSION_LIST.includes(extension)) return true;
  // Extensionless paths are accepted only when they include a directory,
  // which avoids turning ordinary prose words into preview links.
  return path.includes("/");
}

export function parseMessageFileReference(
  value: string,
  cwd?: string,
): MessageFileReference | null {
  let display = stripTrailingPunctuation(value.trim());
  if (!display || display.includes("://") || display.startsWith("~")) return null;

  try {
    display = decodeURIComponent(display);
  } catch {
    return null;
  }
  let path = display.replace(LOCATION_SUFFIX_RE, "");
  path = path.replace(/\\/g, "/");

  if (path.startsWith("/")) {
    const root = cwd?.replace(/\/+$/, "");
    if (!root || !path.startsWith(`${root}/`)) return null;
    path = path.slice(root.length + 1);
  }

  path = path.replace(/^\.\//, "");
  const parts = path.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part === ".." || part.includes("\0"))
  ) {
    return null;
  }
  path = parts.filter((part) => part !== ".").join("/");
  if (!path || !isFileLike(path)) return null;
  if (!path.includes("/") && path.includes("@")) return null;

  return {
    display,
    path,
    name: path.split("/").at(-1) ?? path,
  };
}

export function splitMessageFileReferences(
  text: string,
  cwd?: string,
): MessageFileSegment[] {
  const segments: MessageFileSegment[] = [];
  let offset = 0;
  FILE_TOKEN_RE.lastIndex = 0;

  for (let match = FILE_TOKEN_RE.exec(text); match; match = FILE_TOKEN_RE.exec(text)) {
    const matched = match[0];
    const start = match.index;
    const urlPrefix = text.slice(Math.max(0, start - 12), start);
    const candidate = stripTrailingPunctuation(matched);
    const reference = /(?:https?|ftp):\/\/$/i.test(urlPrefix)
      ? null
      : parseMessageFileReference(candidate, cwd);
    if (!reference) continue;

    if (start > offset) segments.push({ type: "text", text: text.slice(offset, start) });
    segments.push({ type: "file", reference });
    const candidateEnd = start + candidate.length;
    if (candidateEnd < start + matched.length) {
      segments.push({ type: "text", text: text.slice(candidateEnd, start + matched.length) });
    }
    offset = start + matched.length;
  }

  if (offset < text.length) segments.push({ type: "text", text: text.slice(offset) });
  return segments.length > 0 ? segments : [{ type: "text", text }];
}

export function messageFileHref(path: string): string {
  return `${FILE_LINK_PREFIX}${encodeURIComponent(path)}`;
}

export function parseMessageFileHref(href: string, cwd?: string): MessageFileReference | null {
  if (href.startsWith(FILE_LINK_PREFIX)) {
    return parseMessageFileReference(href.slice(FILE_LINK_PREFIX.length), cwd);
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) return null;
  return parseMessageFileReference(href, cwd);
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
};

/** Remark plugin that turns file-looking plain text into project file links. */
export function remarkMessageFileReferences(options: { cwd?: string } = {}) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || node.type === "link" || node.type === "linkReference") return;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (!child) continue;
        if (child.type === "text" && typeof child.value === "string") {
          const segments = splitMessageFileReferences(child.value, options.cwd);
          if (!segments.some((segment) => segment.type === "file")) continue;
          const replacements: MarkdownNode[] = segments.map((segment) =>
            segment.type === "text"
              ? { type: "text", value: segment.text }
              : {
                  type: "link",
                  url: messageFileHref(segment.reference.path),
                  children: [{ type: "text", value: segment.reference.display }],
                },
          );
          node.children.splice(index, 1, ...replacements);
          index += replacements.length - 1;
          continue;
        }
        if (child.type !== "inlineCode" && child.type !== "code") visit(child);
      }
    };
    visit(tree);
  };
}
