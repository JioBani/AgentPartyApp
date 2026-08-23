# Theme authoring contract

AgentParty's 27 built-in themes are declarative JSON files in
[`src/shared/themes/`](../src/shared/themes/). Both the main process and the
renderer synchronously consume the same validated registry. The main process
derives native window backgrounds from `color.bg-0`; the renderer generates CSS
custom properties from the same `color` and `shape` records.

This contract is intentionally only an authoring and registration boundary.
There is no theme file picker, installation endpoint, dynamic directory scan,
or runtime loading feature yet.

## Marketplace popularity pack

Twenty presets are adapted from the most-installed eligible color-theme
extensions in the Visual Studio Marketplace, ordered by Marketplace install
count as observed on 2026-08-23. The selection excludes AgentParty's existing
GitHub, Dracula, and Nord presets; icon/language/companion extensions;
deprecated extensions; duplicate palettes; and themes without a
redistribution-compatible public license. Monokai Pro is intentionally absent
because its Marketplace license forbids redistribution.

The install count ranks the extension, not an individual variant. When an
extension ships several variants, AgentParty uses its primary or namesake dark
variant (Ayu Mirage for Ayu and Catppuccin Mocha for Catppuccin). Each palette
is adapted to AgentParty's complete UI-token and WCAG contrast contract rather
than copying VS Code-specific token names verbatim.

| Rank | AgentParty preset | Marketplace extension | Installs | License |
| ---: | --- | --- | ---: | --- |
| 1 | One Dark Pro | [One Dark Pro](https://marketplace.visualstudio.com/items?itemName=zhuangtongfa.Material-theme) | 12,643,952 | MIT |
| 2 | Atom One Dark | [Atom One Dark Theme](https://marketplace.visualstudio.com/items?itemName=akamud.vscode-theme-onedark) | 7,300,923 | MIT |
| 3 | Ayu Mirage | [Ayu](https://marketplace.visualstudio.com/items?itemName=teabyii.ayu) | 4,180,504 | MIT |
| 4 | Winter is Coming | [Winter is Coming](https://marketplace.visualstudio.com/items?itemName=johnpapa.winteriscoming) | 3,725,217 | MIT |
| 5 | Night Owl | [Night Owl](https://marketplace.visualstudio.com/items?itemName=sdras.night-owl) | 3,562,484 | MIT |
| 6 | One Monokai | [One Monokai](https://marketplace.visualstudio.com/items?itemName=azemoh.one-monokai) | 2,932,431 | MIT |
| 7 | Tokyo Night | [Tokyo Night](https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night) | 2,869,774 | MIT |
| 8 | Palenight | [Palenight](https://marketplace.visualstudio.com/items?itemName=whizkydee.material-palenight-theme) | 2,625,279 | MIT |
| 9 | SynthWave '84 | [SynthWave '84](https://marketplace.visualstudio.com/items?itemName=RobbOwen.synthwave-vscode) | 2,533,074 | MIT |
| 10 | Shades of Purple | [Shades of Purple](https://marketplace.visualstudio.com/items?itemName=ahmadawais.shades-of-purple) | 2,331,417 | MIT |
| 11 | Cobalt2 | [Cobalt2](https://marketplace.visualstudio.com/items?itemName=wesbos.theme-cobalt2) | 1,893,553 | MIT |
| 12 | Andromeda | [Andromeda](https://marketplace.visualstudio.com/items?itemName=EliverLara.andromeda) | 1,688,149 | MIT |
| 13 | Atom One Light | [Atom One Light](https://marketplace.visualstudio.com/items?itemName=akamud.vscode-theme-onelight) | 1,443,935 | MIT |
| 14 | Noctis | [Noctis](https://marketplace.visualstudio.com/items?itemName=liviuschera.noctis) | 1,384,529 | MIT |
| 15 | Catppuccin Mocha | [Catppuccin](https://marketplace.visualstudio.com/items?itemName=Catppuccin.catppuccin-vsc) | 1,367,844 | MIT |
| 16 | Gruvbox Dark Medium | [Gruvbox](https://marketplace.visualstudio.com/items?itemName=jdinhlife.gruvbox) | 1,044,479 | MIT |
| 17 | Sublime Material Dark | [Sublime Material](https://marketplace.visualstudio.com/items?itemName=jprestidge.theme-material-theme) | 1,036,780 | MIT |
| 18 | Omni | [Omni](https://marketplace.visualstudio.com/items?itemName=rocketseat.theme-omni) | 1,006,649 | MIT |
| 19 | JellyFish | [JellyFish](https://marketplace.visualstudio.com/items?itemName=PawelBorkar.jellyfish) | 939,474 | Apache-2.0 |
| 20 | Darcula | [Darcula](https://marketplace.visualstudio.com/items?itemName=rokoroku.vscode-theme-darcula) | 925,648 | MIT |

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
   token set. Every color must use `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`,
   `rgb(r, g, b)` with integer channels from 0 through 255, or
   `rgba(r, g, b, a)` with the same channels and alpha from 0 through 1.
   Named colors, percentages, CSS variables, and color functions outside that
   list are not supported. Every shape must be a nonnegative `px`, `rem`, or
   `em` length; unitless `0` is also supported. `color.bg-0` is also the
   Electron BrowserWindow background.
4. Add one static JSON import, source label, and ordered entry to
   [`themeCatalog.ts`](../src/shared/themeCatalog.ts). Static registration is
   required so first paint never waits on filesystem or asynchronous work.
5. Run `npm run validate:theme-catalog`, `npm run test:theme-settings`, and
   `npm run test:e2e:theme`. `npm run build` and `npm run package:win` run the
   catalog command as a mandatory first gate, before compilation or packaging.
   The theme-settings test
   checks schema/catalog exactness, token completeness, contrast, native
   background agreement, and migration; the E2E test checks the real Settings
   and titlebar UI, restart, synchronous first paint, and multi-window broadcast.

The parser rejects unknown or missing root/token keys, unsupported schema
versions, malformed ids, duplicate ids, and any color or shape outside the
grammars above. Errors include the source and property path, for example:

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
