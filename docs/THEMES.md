# Theme authoring contract

AgentParty's seven built-in themes are declarative JSON files in
[`src/shared/themes/`](../src/shared/themes/). Both the main process and the
renderer synchronously consume the same validated registry. The main process
derives native window backgrounds from `color.bg-0`; the renderer generates CSS
custom properties from the same `color` and `shape` records.

This contract is intentionally only an authoring and registration boundary.
There is no theme file picker, installation endpoint, dynamic directory scan,
or runtime loading feature yet.

## Authoring a built-in theme

1. Copy a complete JSON definition such as
   [`github-light.json`](../src/shared/themes/github-light.json). Keep
   `schemaVersion: 1` and the optional `$schema: "../theme.schema.json"` entry.
   The latter gives editors completion and inline validation through the
   standard draft 2020-12
   [`theme.schema.json`](../src/shared/theme.schema.json).
2. Choose a lowercase kebab-case `id`, a user-facing `label`, and a `scheme` of
   `light` or `dark`.
3. Define every `color` and `shape` token exactly once. The linked built-in JSON
   is a complete valid JSON example; the schema lists and describes the exact
   token set. `color.bg-0` is also the Electron BrowserWindow background.
4. Add one static JSON import, source label, and ordered entry to
   [`themeCatalog.ts`](../src/shared/themeCatalog.ts). Static registration is
   required so first paint never waits on filesystem or asynchronous work.
5. Run `npm run test:theme-settings` and `npm run test:e2e:theme`. The first
   checks schema/catalog exactness, token completeness, contrast, native
   background agreement, and migration; the second checks the real Settings and
   titlebar UI, restart, synchronous first paint, and multi-window broadcast.

The parser rejects unknown or missing root/token keys, unsupported schema
versions, malformed ids, duplicate ids, empty values, and CSS values containing
declaration/block injection or indirect `url()`, `var()`, and `expression()`
syntax. Errors include the source and property path, for example:

```text
my-theme.json.color.bg-0: missing required property
```

## Future runtime-loader boundary

Any future third-party loader must parse untrusted JSON with
`parseThemeDefinition(value, source)` or a batch with
`parseThemeCatalog(values, sources)` from
[`themeSchema.ts`](../src/shared/themeSchema.ts) before registration or CSS
generation. That validator is environment-neutral and performs no I/O, so a
future loader can reuse it without changing this contract. Such a loader must
still define ownership, trust, persistence, collision, and failure UX; none of
those capabilities are introduced by this refactor.
