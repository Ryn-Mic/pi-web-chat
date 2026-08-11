import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/**
 * remark-gfm의 취소선(~~, ~) 문법만 제거한다.
 *
 * 한국어 채팅 텍스트는 물결표가 문장 부호처럼 쓰여 의도치 않은 삭선이 자주
 * 생긴다 ("가격이 ~~2만원~~ 이었는데", "서울~부산~ 고고~"). 특히 이 버전의
 * remark-gfm은 singleTilde가 기본 활성이라 단일 물결표(~x~)마저 삭선이 된다.
 *
 * remark-gfm에는 취소선만 끄는 옵션이 없어서, micromark 확장에서
 * strikethrough 토크나이저(코드 126 = ~)가 등록된 3군데를 직접 제거한다.
 * attacher는 unified가 processor를 this로 바인딩해 호출한다.
 */
function remarkNoStrikethrough(this: unknown) {
  const data = (this as { data?: () => unknown }).data?.() as
    | Record<string, unknown>
    | undefined;
  const exts = data?.micromarkExtensions as Record<string, unknown>[] | undefined;
  if (exts) {
    for (const ext of exts) {
      const text = ext.text as Record<string, unknown> | undefined;
      if (text && Array.isArray(text["126"])) {
        const kept = (text["126"] as { name?: string }[]).filter(
          (t) => t?.name !== "strikethrough"
        );
        if (kept.length) text["126"] = kept;
        else delete text["126"];
      }
      const insideSpan = ext.insideSpan as Record<string, unknown> | undefined;
      if (insideSpan) {
        for (const key of Object.keys(insideSpan)) {
          const arr = insideSpan[key];
          if (Array.isArray(arr)) {
            const kept = (arr as { name?: string }[]).filter(
              (t) => t?.name !== "strikethrough"
            );
            if (kept.length) insideSpan[key] = kept;
            else delete insideSpan[key];
          }
        }
      }
      const attention = ext.attentionMarkers as Record<string, unknown> | undefined;
      if (attention) {
        for (const key of Object.keys(attention)) {
          const arr = attention[key];
          if (Array.isArray(arr)) {
            const kept = (arr as number[]).filter((c) => c !== 126);
            if (kept.length) attention[key] = kept;
            else delete attention[key];
          }
        }
      }
    }
  }
  return () => {};
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none text-[15px] leading-relaxed prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkNoStrikethrough]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // 모바일에서 넓은 표가 화면을 뚫고 나가지 않도록 가로 스크롤 컨테이너로 감싼다.
          table: ({ node: _node, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
