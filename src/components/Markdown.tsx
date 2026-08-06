import { memo, type ReactNode } from "react";
import { Streamdown } from "streamdown";

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
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="max-w-none text-[15px] leading-relaxed">
      <Streamdown mode="streaming" components={components}>
        {text}
      </Streamdown>
    </div>
  );
});
