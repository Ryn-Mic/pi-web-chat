import { isValidElement, memo, useMemo, type ReactNode } from "react";
import {
  defaultRemarkPlugins,
  Streamdown,
  type Components,
} from "streamdown";
import {
  parseMessageFileHref,
  parseMessageFileReference,
  remarkMessageFileReferences,
  splitMessageFileReferences,
  type MessageFileReference,
} from "../lib/message-file-links";
import { useT } from "../lib/i18n";
import { streamdownPlugins } from "../lib/streamdownCode";

export { streamdownPlugins } from "../lib/streamdownCode";

export interface MessageFilePreview {
  cwd: string;
  path: string;
  name: string;
}

export type PreviewMessageFile = (file: MessageFilePreview) => void;

/** Flatten rendered children into text so inline code/path labels can be inspected. */
function flattenText(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return flattenText(node.props.children);
  return "";
}

function Paragraph({ children }: { children?: ReactNode }) {
  const text = flattenText(children);
  if (text.trim().startsWith("Turn took ") || text.trim().startsWith("✻ Turn took ")) {
    return <p className="my-2 text-center text-xs text-faint">{children}</p>;
  }
  return <p>{children}</p>;
}

function FileReferenceButton({
  reference,
  cwd,
  onPreviewFile,
  children,
}: {
  reference: MessageFileReference;
  cwd: string;
  onPreviewFile: PreviewMessageFile;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => onPreviewFile({ cwd, path: reference.path, name: reference.name })}
      className="inline-flex max-w-full items-baseline gap-1 rounded-sm bg-teal-500/10 px-0.5 font-mono text-[0.92em] font-medium text-teal-700 underline decoration-teal-500/70 decoration-dotted underline-offset-2 transition-colors hover:bg-teal-500/15 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
      aria-label={t("previewFile", { name: reference.path })}
      title={reference.path}
    >
      <span className="shrink-0 text-[0.85em] no-underline" aria-hidden>
        {"\uf016"}
      </span>
      <span className="min-w-0 break-all">{children ?? reference.display}</span>
    </button>
  );
}

function useMarkdownComponents(
  cwd?: string,
  onPreviewFile?: PreviewMessageFile,
): Components {
  return useMemo<Components>(() => ({
    p: Paragraph,
    a: ({ href, children, node: _node, ...props }) => {
      const reference = href ? parseMessageFileHref(href, cwd) : null;
      if (reference && cwd && onPreviewFile) {
        return (
          <FileReferenceButton reference={reference} cwd={cwd} onPreviewFile={onPreviewFile}>
            {children}
          </FileReferenceButton>
        );
      }
      const external = typeof href === "string" && /^https?:\/\//i.test(href);
      return (
        <a
          {...props}
          href={href}
          target={external ? "_blank" : props.target}
          rel={external ? "noopener noreferrer" : props.rel}
        >
          {children}
        </a>
      );
    },
    inlineCode: ({ children, node: _node, ...props }) => {
      const label = flattenText(children);
      const reference = parseMessageFileReference(label, cwd);
      if (reference && cwd && onPreviewFile) {
        return (
          <FileReferenceButton reference={reference} cwd={cwd} onPreviewFile={onPreviewFile}>
            {children}
          </FileReferenceButton>
        );
      }
      return <code {...props}>{children}</code>;
    },
  }), [cwd, onPreviewFile]);
}

export function PlainTextFileLinks({
  text,
  cwd,
  onPreviewFile,
}: {
  text: string;
  cwd?: string;
  onPreviewFile?: PreviewMessageFile;
}) {
  if (!cwd || !onPreviewFile) return text;
  return splitMessageFileReferences(text, cwd).map((segment, index) =>
    segment.type === "text" ? (
      <span key={index}>{segment.text}</span>
    ) : (
      <FileReferenceButton
        key={`${segment.reference.path}-${index}`}
        reference={segment.reference}
        cwd={cwd}
        onPreviewFile={onPreviewFile}
      />
    ),
  );
}

/**
 * Streaming markdown renderer (Streamdown). Unlike react-markdown it handles
 * incomplete syntax (unclosed ** / fences / links) natively via remend, which
 * removes the need for manual marker-escaping and the full re-parse jank on
 * every delta.
 *
 * While streaming, the Shiki plugin is withheld: Streamdown re-highlights a
 * fence on every code change (its highlighted body keys the effect on `code`),
 * and our token cache keys on the full source, so a growing code block would be
 * re-tokenised from scratch on every flush. Without the plugin the fence renders
 * as plain text, and dropping the plugin back in once the message settles
 * highlights it exactly once. The prop must be switched here rather than inside
 * the plugin: `HighlightOptions` carries no streaming flag, and a module-level
 * flag would also strip highlighting from the completed messages rendered
 * alongside the streaming one.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  cwd,
  onPreviewFile,
}: {
  text: string;
  /** Streaming mode keeps incomplete markdown open; static mode avoids the
      extra normalization and transition work for completed messages. */
  streaming?: boolean;
  cwd?: string;
  onPreviewFile?: PreviewMessageFile;
}) {
  const components = useMarkdownComponents(cwd, onPreviewFile);
  const remarkPlugins = useMemo(
    () => [
      ...Object.values(defaultRemarkPlugins),
      [remarkMessageFileReferences, { cwd }] as [
        typeof remarkMessageFileReferences,
        { cwd?: string },
      ],
    ],
    [cwd],
  );

  return (
    <div className="message-markdown max-w-none leading-[1.6]">
      <Streamdown
        key={cwd ?? "no-workspace"}
        mode={streaming ? "streaming" : "static"}
        components={components}
        remarkPlugins={remarkPlugins}
        plugins={streaming ? undefined : streamdownPlugins}
      >
        {text}
      </Streamdown>
    </div>
  );
});
