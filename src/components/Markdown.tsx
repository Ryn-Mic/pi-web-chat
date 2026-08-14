import { memo, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { streamdownPlugins } from "../lib/streamdownCode";

export { streamdownPlugins } from "../lib/streamdownCode";

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
const components = {
  p: ({ children }: { children?: ReactNode }) => {
    const text = flattenText(children);
    if (text.trim().startsWith("✻ Turn took ")) {
      return <p className="my-2 text-center text-xs text-faint">{children}</p>;
    }
    return <p>{children}</p>;
  },
};

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
}: {
  text: string;
  /** Streaming mode keeps incomplete markdown open; static mode avoids the
      extra normalization and transition work for completed messages. */
  streaming?: boolean;
}) {
  return (
    <div className="message-markdown max-w-none leading-[1.6]">
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        components={components}
        plugins={streaming ? undefined : streamdownPlugins}
      >
        {text}
      </Streamdown>
    </div>
  );
});
