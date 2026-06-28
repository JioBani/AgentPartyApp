import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model-authored text as GitHub-flavored markdown (headings, lists,
 * tables, fenced code, links) with app-styled elements. Used for assistant
 * replies and inter-member message bodies so prose, JSON/code blocks, and
 * tables are human-readable instead of raw markdown source.
 *
 * Block code is left in react-markdown's default `<pre>` and styled to wrap;
 * inline code gets a distinct chip. Detection avoids react-markdown v9's removed
 * `inline` prop by checking for a language class or a newline in the content.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="wb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          code({ node: _node, className, children, ...props }) {
            const content = String(children ?? "");
            const isBlock = /language-/.test(className || "") || content.includes("\n");
            if (isBlock) {
              return <code className={className} {...props}>{children}</code>;
            }
            return <code className="wb-md-code-inline" {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
