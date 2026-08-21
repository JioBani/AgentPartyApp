export const THEME_SCHEMA_VERSION = 1 as const;

export const THEME_COLOR_TOKENS = [
  "bg-0", "bg-1", "bg-2", "bg-3", "bg-4", "bg-input",
  "border-subtle", "border", "border-strong",
  "text-0", "text-1", "text-2", "text-3",
  "accent", "accent-dim", "accent-bd", "accent-fg",
  "selection", "selection-fg", "status", "status-fg",
  "live", "live-dim", "live-bd", "compact-zone",
  "success", "success-dim", "success-bd",
  "danger", "danger-dim", "danger-bd", "danger-fg",
  "warning", "warning-dim", "warning-bd", "warning-fg",
  "grid", "scrim", "shadow", "shadow-strong",
] as const;

export const THEME_SHAPE_TOKENS = [
  "radius-window", "radius-panel", "radius-card", "radius-button",
  "radius-input", "radius-pill", "radius-badge",
  "border-width", "focus-ring-width",
] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export type ThemeShapeToken = (typeof THEME_SHAPE_TOKENS)[number];
export type ThemeScheme = "light" | "dark";

const RGB_CHANNEL = "(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)";
const RGB_ALPHA = "(?:0(?:\\.\\d+)?|1(?:\\.0+)?|\\.\\d+)";
export const THEME_COLOR_VALUE_PATTERN = `^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgb\\( *${RGB_CHANNEL} *, *${RGB_CHANNEL} *, *${RGB_CHANNEL} *\\)|rgba\\( *${RGB_CHANNEL} *, *${RGB_CHANNEL} *, *${RGB_CHANNEL} *, *${RGB_ALPHA} *\\))$`;
export const THEME_SHAPE_VALUE_PATTERN = "^(?:0|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:px|rem|em))$";

const THEME_COLOR_VALUE = new RegExp(THEME_COLOR_VALUE_PATTERN);
const THEME_SHAPE_VALUE = new RegExp(THEME_SHAPE_VALUE_PATTERN);

export interface ThemeDefinition {
  readonly $schema?: string;
  readonly schemaVersion: typeof THEME_SCHEMA_VERSION;
  readonly id: string;
  readonly label: string;
  readonly scheme: ThemeScheme;
  readonly color: Readonly<Record<ThemeColorToken, string>>;
  readonly shape: Readonly<Record<ThemeShapeToken, string>>;
}

export class ThemeDefinitionError extends Error {
  readonly code = "invalid_theme_definition" as const;
  constructor(readonly source: string, readonly path: string, detail: string) {
    super(`${source}${path ? `.${path}` : ""}: ${detail}`);
    this.name = "ThemeDefinitionError";
  }
}

const ROOT_KEYS = ["$schema", "schemaVersion", "id", "label", "scheme", "color", "shape"] as const;
const THEME_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function recordAt(value: unknown, source: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeDefinitionError(source, path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], source: string, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ThemeDefinitionError(source, path ? `${path}.${unknown[0]}` : unknown[0], "unknown property");
  const missing = required.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw new ThemeDefinitionError(source, path ? `${path}.${missing}` : missing, "missing required property");
}

function stringAt(value: unknown, source: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ThemeDefinitionError(source, path, "must be a non-empty string");
  return value;
}

export function isThemeColorValue(value: unknown): value is string {
  return typeof value === "string" && THEME_COLOR_VALUE.test(value);
}

export function isThemeShapeValue(value: unknown): value is string {
  return typeof value === "string" && THEME_SHAPE_VALUE.test(value);
}

function tokenRecord<T extends string>(value: unknown, tokens: readonly T[], source: string, path: string, accepts: (value: unknown) => value is string, grammar: string): Readonly<Record<T, string>> {
  const record = recordAt(value, source, path);
  assertExactKeys(record, tokens, tokens, source, path);
  return Object.freeze(Object.fromEntries(tokens.map((token) => {
    const tokenValue = record[token];
    if (!accepts(tokenValue)) throw new ThemeDefinitionError(source, `${path}.${token}`, grammar);
    return [token, tokenValue];
  }))) as Readonly<Record<T, string>>;
}

/**
 * Synchronous, environment-neutral boundary for built-in JSON today and a
 * possible runtime loader later. It performs no filesystem or install work.
 */
export function parseThemeDefinition(value: unknown, source = "theme"): ThemeDefinition {
  const root = recordAt(value, source, "");
  assertExactKeys(root, ROOT_KEYS, ROOT_KEYS.filter((key) => key !== "$schema"), source, "");
  if (root.schemaVersion !== THEME_SCHEMA_VERSION) {
    throw new ThemeDefinitionError(source, "schemaVersion", `must equal ${THEME_SCHEMA_VERSION}`);
  }
  if (root.$schema !== undefined) stringAt(root.$schema, source, "$schema");
  const id = stringAt(root.id, source, "id");
  if (!THEME_ID_PATTERN.test(id)) throw new ThemeDefinitionError(source, "id", "must use lowercase kebab-case");
  const label = stringAt(root.label, source, "label");
  if (root.scheme !== "light" && root.scheme !== "dark") throw new ThemeDefinitionError(source, "scheme", "must be light or dark");
  return Object.freeze({
    ...(root.$schema === undefined ? {} : { $schema: root.$schema as string }),
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    label,
    scheme: root.scheme,
    color: tokenRecord(root.color, THEME_COLOR_TOKENS, source, "color", isThemeColorValue, "must be #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(0-255, ...), or rgba(0-255, ..., 0-1)"),
    shape: tokenRecord(root.shape, THEME_SHAPE_TOKENS, source, "shape", isThemeShapeValue, "must be a nonnegative CSS length: 0 or a px/rem/em value"),
  });
}

/** Rejects duplicates before callers construct lookup maps. */
export function parseThemeCatalog(values: readonly unknown[], sources: readonly string[] = []): readonly ThemeDefinition[] {
  const themes = values.map((value, index) => parseThemeDefinition(value, sources[index] ?? `theme[${index}]`));
  const seen = new Map<string, string>();
  for (const [index, theme] of themes.entries()) {
    const source = sources[index] ?? `theme[${index}]`;
    const firstSource = seen.get(theme.id);
    if (firstSource) throw new ThemeDefinitionError(source, "id", `duplicate id '${theme.id}' (already registered by ${firstSource})`);
    seen.set(theme.id, source);
  }
  return Object.freeze(themes);
}

export function requireThemeInCatalog(themes: readonly ThemeDefinition[], id: string, source = "theme catalog"): ThemeDefinition {
  const theme = themes.find((entry) => entry.id === id);
  if (!theme) throw new ThemeDefinitionError(source, "default", `missing default theme '${id}'`);
  return theme;
}
