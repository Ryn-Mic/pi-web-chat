import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/** Flatten p's children into plain text so they can be inspected */
function flattenText(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  return "";
}

/**
 * Dim the "✻ Turn took …" meta line added by the pi-claude-code-ui extension.
 * ANSI codes are already stripped server-side (serialize).
 */
const components: Components = {
  p: ({ children }) => {
    const text = flattenText(children);
    if (text.trim().startsWith("✻ Turn took ")) {
      return <p className="my-2 text-center text-xs text-faint">{children}</p>;
    }
    return <p>{children}</p>;
  },
  // The message list container is overflow-x-hidden; give tables their own
  // horizontal scroll container so all columns are reachable on mobile
  // without moving the page.
  table: ({ children }) => (
    // Defer margins to the typography table defaults; the container only scrolls
    <div className="overflow-x-auto thin-scroll">
      <table className="w-full text-left text-[0.875em] leading-relaxed">{children}</table>
    </div>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none text-[15px] leading-relaxed prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-h1:text-[1.35em] prose-h2:text-[1.2em] prose-h3:text-[1.08em] prose-h4:text-[1em] prose-h5:text-[0.95em] prose-h6:text-[0.9em] prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
