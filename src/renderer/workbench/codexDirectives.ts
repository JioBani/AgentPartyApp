/**
 * Codex emits these two inline directives in assistant Markdown. Keep them in
 * the stored transcript (and in Copy reply), but turn them into ordinary mdast
 * links for display. Working on text nodes leaves code, HTML and existing links
 * literal, matching the Codex TUI's file-citation boundary.
 */
type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
};

type ParsedDirective = { kind: "file" | "followup"; end: number; path?: string; label?: string; prompt?: string };

function parseAttributes(input: string, start: number): { end: number; values: Record<string, string> } | null {
  const values: Record<string, string> = {};
  let at = start;
  while (at < input.length) {
    while (/\s/.test(input[at] || "")) at++;
    if (input[at] === "}") return { end: at + 1, values };
    const name = /^[a-z][\w-]*/i.exec(input.slice(at))?.[0];
    if (!name) return null;
    at += name.length;
    if (input[at++] !== "=") return null;
    let value = "";
    if (input[at] === '"' || input[at] === "'") {
      const quote = input[at++];
      const from = at;
      // A Windows trailing backslash is literal. A quote only closes a value
      // when the next character starts another attribute or ends the directive.
      while (at < input.length && !(input[at] === quote && /[\s}]/.test(input[at + 1] || ""))) at++;
      if (at >= input.length) return null;
      value = input.slice(from, at++);
    } else {
      const from = at;
      while (at < input.length && !/[\s}]/.test(input[at])) at++;
      value = input.slice(from, at);
    }
    values[name] = value;
  }
  return null;
}

function parseDirective(input: string, start: number): ParsedDirective | null {
  const file = ":codex-file-citation{";
  const followup = ":codex-followup[";
  if (input.startsWith(file, start)) {
    const attrs = parseAttributes(input, start + file.length);
    return attrs?.values.path ? { kind: "file", end: attrs.end, path: attrs.values.path } : null;
  }
  if (!input.startsWith(followup, start)) return null;
  const labelEnd = input.indexOf("]{", start + followup.length);
  if (labelEnd < 0) return null;
  const label = input.slice(start + followup.length, labelEnd);
  const attrs = parseAttributes(input, labelEnd + 2);
  return label && attrs?.values.prompt
    ? { kind: "followup", end: attrs.end, label, prompt: attrs.values.prompt }
    : null;
}

function escapedAt(source: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
  return slashes % 2 !== 0;
}

function directiveLink(directive: ParsedDirective): MarkdownNode {
  if (directive.kind === "file") {
    const path = directive.path!;
    const filename = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
    return {
      type: "link",
      // MarkdownLink uses the original path in data-codex-file-path. The URL is
      // still a local href so link sanitisation remains narrow.
      url: path,
      children: [{ type: "text", value: filename }],
      data: { hProperties: { "data-codex-file-path": path } },
    };
  }
  return {
    type: "link",
    url: "#codex-followup",
    children: [{ type: "text", value: directive.label }],
    data: { hProperties: { "data-codex-followup-prompt": directive.prompt } },
  };
}

function transformText(node: MarkdownNode, source: string): MarkdownNode[] {
  const value = node.value || "";
  if (!value.includes(":codex-")) return [node];
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  const raw = typeof start === "number" && typeof end === "number" ? source.slice(start, end) : value;
  const output: MarkdownNode[] = [];
  let valueAt = 0;
  let searchAt = 0;
  let rawAt = 0;
  while (true) {
    const at = value.indexOf(":codex-", searchAt);
    if (at < 0) break;
    const parsed = parseDirective(value, at);
    const rawStart = raw.indexOf(":codex-", rawAt);
    const original = rawStart >= 0 ? parseDirective(raw, rawStart) : null;
    if (!parsed || !original || parsed.kind !== original.kind || escapedAt(raw, rawStart)) {
      searchAt = at + 7;
      if (rawStart >= 0) rawAt = rawStart + 7;
      continue;
    }
    if (at > valueAt) output.push({ type: "text", value: value.slice(valueAt, at) });
    output.push(directiveLink(original));
    valueAt = parsed.end;
    searchAt = parsed.end;
    rawAt = original.end;
  }
  if (!output.length) return [node];
  if (valueAt < value.length) output.push({ type: "text", value: value.slice(valueAt) });
  return output;
}

export function remarkCodexDirectives() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : "";
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "image", "imageReference", "code", "inlineCode", "html"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text") return transformText(child, source);
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
