import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/** p 의 children 을 평문으로 펼쳐 검사할 수 있게 한다 */
function flattenText(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  return "";
}

/**
 * pi-claude-code-ui 확장이 붙이는 "✻ Turn took …" 메타 줄을 흐리게 표시.
 * ANSI 코드는 서버(serialize)에서 제거된 뒤 도착한다.
 */
const components: Components = {
  p: ({ children }) => {
    const text = flattenText(children);
    if (text.trim().startsWith("✻ Turn took ")) {
      return <p className="my-2 text-center text-xs text-faint">{children}</p>;
    }
    return <p>{children}</p>;
  },
  // 페이지 전체(메시지 리스트)는 overflow-x-hidden 인데, 테이블만 자체 컨테이너에서
  // 가로 스크롤할 수 있게 한다. → 모바일에서도 모든 열을 볼 수 있다.
  table: ({ children }) => (
    // margin 은 typography 테이블 기본값에 맡기고 컨테이너는 스크롤만 담당
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
