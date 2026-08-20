/**
 * Browser-safe classification of markdown hrefs that are local files.
 *
 * Kept out of `localFiles` / `workspaceLocation` because those import `node:path`.
 * The renderer only needs to PRESERVE these hrefs through react-markdown's
 * sanitiser and hand them to `openPath` — host resolution happens in main.
 */
import { isWindowsDrivePath } from "./windowsDrivePath";

/** `file:` URLs the sanitiser must keep so MarkdownLink can classify them. */
export function isLocalFileUrl(href: string): boolean {
  const value = String(href || "").trim();
  if (!/^file:/i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol.toLowerCase() !== "file:") {
      return false;
    }
    const host = (url.hostname || "").toLowerCase();
    return host === "" || host === "localhost" || host === "wsl.localhost" || host === "wsl$";
  } catch {
    return /^file:\/\/wsl\$\//i.test(value);
  }
}

/** Drive-absolute paths and local `file:` URLs — the narrow set we opt out of default sanitisation. */
export function isPreservedLocalHref(href: string): boolean {
  return isWindowsDrivePath(href) || isLocalFileUrl(href);
}
