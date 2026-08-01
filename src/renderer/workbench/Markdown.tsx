import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./copy";

/**
 * Renders model-authored text as GitHub-flavored markdown (headings, lists,
 * tables, fenced code, links) with app-styled elements. Used for assistant
 * replies and inter-member message bodies so prose, JSON/code blocks, and
 * tables are human-readable instead of raw markdown source.
 *
 * Block code is left in react-markdown's default `<pre>` and styled to wrap;
 * inline code gets a distinct chip. Detection avoids react-markdown v9's removed
 * `inline` prop by checking for a language class or a newline in the content.
 *
 * Links open in the OS default browser (never inside an Electron window) and
 * carry a copy control for the target URL; so does every fenced code block.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="wb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, children, ...props }) => <MarkdownLink href={href} {...props}>{children}</MarkdownLink>,
          pre: ({ node: _node, children, ...props }) => <MarkdownPre {...props}>{children}</MarkdownPre>,
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

/**
 * A fenced code block with a one-click copy control. The control lives INSIDE
 * the `<pre>` (absolutely positioned) rather than in a wrapper element, so the
 * markdown block structure `.wb-md` styles — including the first/last-child
 * margin rules — is untouched.
 */
function MarkdownPre({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) {
  const code = textOf(children);
  return (
    <pre {...props}>
      {children}
      {code && <CopyButton text={code} title="코드 복사" className="wb-md-pre-copy" />}
    </pre>
  );
}

/**
 * The plain text behind a rendered markdown subtree — what a copy control must
 * put on the clipboard. react-markdown hands `<pre>` its `<code>` element, so
 * the string content is one or two levels down.
 */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  const children = (node as { props?: { children?: ReactNode } }).props?.children;
  return children === undefined ? "" : textOf(children);
}

/**
 * A link in model-authored markdown. Clicking hands the URL to the OS default
 * browser through the main process (`shell.openExternal`) instead of letting
 * Electron navigate the app window away from the workbench. A copy control sits
 * next to it so the target can be taken without opening it.
 *
 * Only http(s) is routed externally — the main handler rejects anything else —
 * so a non-web href (an anchor, a mailto) is left as a plain, inert link.
 */
function MarkdownLink({ href, children, ...props }: { href?: string; children?: ReactNode } & Record<string, unknown>) {
  const external = Boolean(href && /^https?:\/\//i.test(href));
  return (
    <span className="wb-md-link">
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!external) {
            return;
          }
          event.preventDefault();
          void window.agentParty.openExternal(href!);
        }}
      >
        {children}
      </a>
      {external && <CopyButton text={href!} title="링크 복사" className="wb-md-link-copy" />}
    </span>
  );
}
