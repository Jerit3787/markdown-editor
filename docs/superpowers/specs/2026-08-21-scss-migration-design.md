# SCSS Migration Design

## Context

`client/src/style.css` is a single flat file, 3946 lines, ~229 distinct
top-level selectors spanning every UI area of the app (topbar, sidebar,
comments panel, diagram editor, diff view, share/workspace UI, modals,
command palette, and more). It has no internal section markers — related
rules for the same component are scattered by whatever order they were
added historically, not grouped. Editing any one feature's styling means
searching the whole file.

Loaded via a plain side-effect import, `client/src/main.ts:12`:
`import "./style.css";` — Vite (via `vite-plugin-svelte`) picks this up
and bundles it. `style.css` itself has one existing import at the top:
`@import "katex/dist/katex.min.css";`, pulling in a third-party
package's stylesheet.

Theming is entirely runtime: CSS custom properties (`--accent`, `--bg`,
`--text`, etc.) defined on `:root` and overridden under
`[data-theme="dark"]`, toggled by the app's own JS. This is
Sass-incompatible if naively "upgraded" to SCSS `$variables` — those
resolve once at build time and would freeze the app into a single theme,
breaking dark/light switching entirely.

## Goals

- Convert `client/src/style.css` to SCSS, split into partials by UI/
  component area (not the classic 7-1 base/layout/components pattern) —
  mirroring how this codebase is already organized on the JS side after
  the editor-core migration (`Editor.svelte`, `Preview.svelte`,
  `CommentsPanel.svelte`, `Share.svelte`, etc.), so a partial's location
  is predictable from knowing which Svelte component it styles.
- Proposed partition (`client/src/styles/`, 15 files — refined during
  implementation as each section's actual rules are read, not decided
  purely from selector-name prefixes):
  - `_variables.scss` — `:root`/`[data-theme="dark"]` custom properties,
    base resets (`html`, `body`, box-sizing, etc.)
  - `_layout.scss` — `#app`, `#body`, `#main`, `#content-row`,
    `#divider`, the top-level grid structure
  - `_topbar.scss` — `#topbar*`, `#brand`, `#toolbar*`
  - `_sidebar.scss` — `#sidebar*`, `.doc*`, `.doclist*`, `#docList`
  - `_editor-preview.scss` — `#editor*`, `#preview*`, `.outline*`
  - `_statusbar.scss` — `#statusbar`, `.save*`, `#saveStatusBtn`
  - `_menu.scss` — `.menu*`, `#menuBar`, `.menubar*`
  - `_command-palette.scss` — `.command-palette*`
  - `_modals.scss` — `.modal*`, `.about*`, `.settings*`,
    `.shortcuts*`, `.whats*`
  - `_comments.scss` — `.comment*`, `.comments*`
  - `_share-workspace.scss` — `.share*`, `.workspace*`, `.presence*`
  - `_diagram-editor.scss` — `.diagram*`
  - `_diff-view.scss` — `.diff*`, `.version*`
  - `_slash-wikilink.scss` — `.slash*` and wikilink-menu rules
  - `_utilities.scss` — small shared bits with no other natural home:
    `.toast*`, `.dropdown*`, `.toggletip*`, `.skeleton*`, `.hint*`,
    `.icon*`, `.primary-btn`/`.secondary-btn`/`.danger-btn`,
    `.empty*`, `.tab*`, `.spacer`, `.sep`, `.sr-only`,
    `.desktop-only`, `.image*`
  - `client/src/style.scss` — the entry point: the existing
    `@import "katex/dist/katex.min.css";` (unchanged — Sass passes
    through any `@import` ending in `.css` as a native CSS import, no
    special handling needed) followed by `@use` for each partial above.
- Within each partial, nest selectors that share a common prefix for
  visual grouping (e.g. `.diagram-editor { &-header { ... } &-body {
  ... } }`), but the **compiled output's actual selectors must stay
  identical** to today's flat ones — this is a structural/readability
  change to the source, not a rename of any class or ID the DOM/JS
  actually uses.
- Every `var(--x)` reference stays exactly as-is — no CSS custom
  property becomes an SCSS `$variable`. `:root`/`[data-theme="dark"]`
  blocks are copied into `_variables.scss` verbatim.
- `client/src/main.ts:12` becomes `import "./style.scss";`. Add `sass`
  as a devDependency — Vite's Sass support is built in, needs no
  `vite.config.ts` changes beyond the package being installed.
- **Verification, not just review**: compile today's `style.css` as-is
  through `sass` (Sass can compile plain `.css`, it's valid input) and
  compile the new `style.scss` (with its partials) through `sass`, then
  diff the two compiled outputs after normalizing selector/rule
  ordering and whitespace. The diff must be empty before this is ever
  committed — proof the split+nesting is 100% behavior-preserving, the
  same bar the Prettier reformat was held to (verified there via a
  whitespace-stripped byte comparison; this needs an analogous but
  CSS-aware comparison since nesting genuinely restructures the source,
  even though the compiled output must match).

## Non-goals

- Converting any CSS custom property to an SCSS variable. Theming stays
  100% runtime, exactly as it works today.
- Introducing SCSS mixins, functions, `@each`/`@for` loops, or any
  other Sass feature beyond `@use` (for partials) and `&`-nesting (for
  grouping). This migration is about file organization and visual
  grouping, not about adopting Sass's programming features — a
  separate, later decision if it ever comes up.
- Changing any actual style (color, spacing, sizing) anywhere,
  including `style.css`'s topbar/logo/action-icon section, which stays
  under its existing lock — this migration only restructures source
  files and adds nesting, it doesn't touch declared values.
- Renaming any class or ID. The compiled CSS's selectors must be
  byte-for-byte the same strings as today (verified per the Goals
  section's diff check) — Svelte components and `client/index.html`
  keep referencing exactly the class/ID names they already use.
- Auto-generating the partition from tooling (e.g. a script that
  guesses boundaries from selector prefixes). The proposed 15-file
  split above is a starting point; the implementer reads each section's
  actual rules while extracting it and adjusts boundaries where a
  selector's real content fits its neighbor's partial better than what
  its name alone suggested.

## Architecture

### Migration mechanics (per partial, repeated ~15 times)

1. Identify the selector range for the partial's area (e.g. every rule
   whose selector starts with `.diagram` or is nested under a
   `.diagram-editor-*` ancestor, including any of that area's own
   `[data-theme="dark"]` overrides and media queries — these currently
   live wherever they were added, not necessarily adjacent to the base
   rule).
2. Cut that range out of `style.css` into the new partial file
   (`client/src/styles/_diagram-editor.scss`), converting matching
   selector prefixes into `&`-nested groups where it clarifies
   structure, leaving genuinely standalone selectors flat.
3. Add `@use "./styles/diagram-editor";` (no leading underscore, no
   extension — Sass's own `@use` convention) to `style.scss`.
4. After all 15 partials are extracted and `style.css` is empty (or
   deleted), run the compiled-output diff (Goals section) against the
   pre-migration `style.css` to confirm nothing was dropped, duplicated,
   or reordered in a way that changes cascade behavior.

### Cascade-order risk

Splitting one file into many `@use`d partials changes the *source
order* rules appear in only if the partition's `@use` order in
`style.scss` differs from where those same rules used to sit in the
original flat file. Two selectors of equal specificity where the later
one currently wins (relying on source order, not specificity) would
silently flip if their partials get `@use`d in a different relative
order than their original position. The compiled-output diff (Goals
section) catches this categorically — it doesn't just check "are all
the same rules present," it checks the compiled stylesheet is
byte-identical modulo whitespace/comment normalization, which includes
rule order.

## Testing

- The compiled-output diff described above is the primary
  correctness check, run once after all partials are extracted.
- `npm run build` must still succeed (confirms Vite's Sass integration
  is wired correctly end-to-end, not just that a standalone `sass`
  compile works).
- `npm run test:e2e:local` (44 tests) — several existing specs already
  assert on rendered layout/visibility (view-mode toggling, focus mode,
  comments panel open/close, preview rendering) and would catch a
  regression the compiled-output diff's normalization happened to miss
  (e.g. a whitespace-normalization edge case masking a real change).
- A manual visual pass in a real browser (light + dark theme, desktop +
  mobile widths) covering at minimum: topbar, sidebar, editor/preview
  split view, comments panel open, command palette open, one modal
  (Settings), the diagram editor, and a Version History diff view —
  the areas with the most complex/historically-fragile CSS per this
  project's own CHANGELOG (topbar sizing lock, mobile bottom-sheet
  animations, comments panel collapse width).

## Self-review

- **Placeholder scan**: no TBD/TODO. The partition list is a concrete,
  named 15-file proposal, not a placeholder — Non-goals explicitly
  documents that boundaries may shift slightly during implementation
  based on what's actually found in each section, which is a real
  constraint, not vague hand-waving.
- **Internal consistency**: the nesting Goal ("nest for grouping") and
  the Non-goal ("don't rename any class/ID") are reconciled explicitly
  — nesting via `&` is source-level grouping only, and the
  compiled-output diff is the mechanism that proves the two goals don't
  conflict in practice.
- **Scope check**: single file → 16 files (15 partials + entry point),
  one migration mechanism repeated per partial. Fits one implementation
  plan; each partial's extraction is a natural task boundary.
