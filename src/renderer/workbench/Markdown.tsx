import { memo, type ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./copy";
import { reportNotice } from "../app/appNotice";
import { ipcErrorMessage } from "../app/ipcError";
import { isWindowsDrivePath } from "../../shared/windowsDrivePath";
import { isLocalFileUrl, isPreservedLocalHref } from "../../shared/localFileHref";
import { localized, useI18n } from "../i18n/I18nProvider";

type PositionedMarkdownNode = {
  type?: string;
  url?: string;
  children?: PositionedMarkdownNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

/**
 * CommonMark treats a backslash before ASCII punctuation as an escape. That is
 * correct for prose, but destructive inside a Windows link destination:
 * `novel\[4060182]` reaches the link node as `novel[4060182]`, so the OS is
 * handed a path with a missing directory separator.
 *
 * The parsed link node keeps source offsets. Inspect only that original slice,
 * and only angle-bracketed drive paths that actually contain such an ambiguous
 * separator. Converting the destination to forward slashes before the URL
 * transform is lossless on Windows and leaves prose, code, web URLs, and normal
 * backslash paths untouched.
 */
function remarkPreserveWindowsPathSeparators() {
  return (tree: PositionedMarkdownNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : "";
    const visit = (node: PositionedMarkdownNode) => {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (node.type === "link" && typeof start === "number" && typeof end === "number") {
        const raw = source.slice(start, end);
        const destination = /\]\(<([a-z]:\\[^>\r\n]*)>/i.exec(raw)?.[1] || "";
        if (/\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(destination)) {
          node.url = destination.replace(/\\/g, "/");
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

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
  useI18n(); // Keep localized link/code attributes live when the locale changes.
  return (
    <div className="wb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkPreserveWindowsPathSeparators]}
        // react-markdown treats `C:` and `file:` as unsafe schemes and erases
        // the href before our link component can classify it. Preserve the
        // narrow local-file grammar; every other URL keeps the library's
        // default sanitisation.
        urlTransform={(url) => isPreservedLocalHref(url) ? url : defaultUrlTransform(url)}
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
      {code && <CopyButton text={code} title={localized("STR-1679")} className="wb-md-pre-copy" />}
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
 * File-ish endings that make a dotted token a PATH, not a host. Without this
 * `[readme](API.md)` would be "opened" as https://API.md. The list is short on
 * purpose: it only has to cover what a model actually writes as a bare relative
 * link in this app's conversations.
 */
const FILE_ENDINGS = /\.(md|markdown|txt|json|ya?ml|log|csv|png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|[jt]sx?|mjs|cjs|css|html?|py|rs|go|java|sh|ps1)$/i;

/**
 * The address to hand the OS for a markdown href, or "" when there is none.
 *
 * Models write plenty of links that are plainly meant for the web but carry no
 * scheme — `[docs](example.com)`, `[site](www.example.com/pricing)`. Left alone
 * those resolve against the app's own URL, so the main-process guard sees a
 * `file://…/dist-renderer/example.com` and refuses it: the link does nothing.
 * Recovering the intent has to happen HERE, because only the renderer still has
 * the href as it was written.
 *
 * `mailto:` is deliberately NOT returned: the anchor is left to the main guard,
 * which already hands it to the OS. Anything else — a real relative path, an
 * in-page anchor — returns "" and keeps the browser's own behaviour.
 */
function externalTarget(href: string | undefined): string {
  const value = (href || "").trim();
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  // A scheme other than http(s) (mailto:, vscode:, …) is not ours to rewrite.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return "";
  }
  // Explicitly relative or absolute paths are paths, not hosts.
  if (/^[./\\#?]/.test(value)) {
    return "";
  }
  const host = value.split(/[/?#]/)[0];
  const looksLikeHost = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !FILE_ENDINGS.test(host);
  return looksLikeHost ? `https://${value}` : "";
}

/**
 * A link in model-authored markdown. Clicking hands the URL to the OS default
 * browser through the main process (`shell.openExternal`) instead of letting
 * Electron open it in an app window. A copy control sits next to it so the
 * target can be taken without opening it.
 *
 * This is the FIRST of two guards, not the only one. `guardNavigation` in main
 * closes the same boundary for everything this component never sees — a
 * middle-click, a dropped URL, a link some other view renders. This one exists
 * because it is the only place that still knows the href as authored, which is
 * what makes a scheme-less `example.com` recoverable.
 */
function MarkdownLink({ href, children, ...props }: { href?: string; children?: ReactNode } & Record<string, unknown>) {
  const target = externalTarget(href);
  // Anything left over that is not an in-page anchor or a foreign scheme is a
  // path — a file the member wrote or read. A bare `C:/...` superficially
  // matches the URI-scheme grammar (`C:`), so recognise drive paths first.
  const file = !target && href && (isWindowsDrivePath(href) || isLocalFileUrl(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("#"))) ? href : "";
  const copyable = target || file;
  return (
    <span className="wb-md-link">
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!target && !file) {
            return;
          }
          event.preventDefault();
          if (target) {
            void window.agentParty.openExternal(target);
            return;
          }
          // The reply matters: it says whether the file opened or was only
          // revealed (no handler / not launchable), and a missing file is an
          // error the user has to see rather than a click that did nothing.
          void window.agentParty
            .openPath(file)
            .then((result: { action?: string; path?: string; reason?: string }) => {
              if (result?.reason) {
                reportNotice(result.reason);
              }
            })
            .catch((error: unknown) => reportNotice(`파일을 열지 못했습니다: ${ipcErrorMessage(error)}`));
        }}
      >
        {children}
      </a>
      {copyable && <CopyButton text={copyable} title={target ? localized("STR-1682") : localized("STR-1681")} className="wb-md-link-copy" />}
      {/* A file has a second thing you may want: the folder it sits in. Opening
          and revealing are different intents — "read this" vs "where is it" —
          so revealing gets its own control rather than being the fallback you
          reach by having no default app. */}
      {file && (
        <button
          type="button"
          className="wb-md-link-reveal"
          title={localized("STR-1683")}
          aria-label={localized("STR-1684")}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void window.agentParty
              .revealPath(file)
              .catch((error: unknown) => reportNotice(`파일 위치를 열지 못했습니다: ${ipcErrorMessage(error)}`));
          }}
        >
          <FolderOpen size={12} />
        </button>
      )}
    </span>
  );
}
