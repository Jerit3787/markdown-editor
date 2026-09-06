# Test Coverage Catalog & Maintenance-Phase Testing — Design Spec

## Goal

The app has grown to ~18k lines of application code (client + Worker)
across ~40 Svelte components and two generations of Durable Object,
shipped over ~975 commits since 2026-08-01. Most of that work landed
feature-first, with regression tests added reactively — several shipped
bugs in `CHANGELOG.md` / `TODO.md` never got a test at all (the
refresh-content-duplication bug `f723634`, the mid-session new-doc sync
bug `b0a1b9b`, the toolbar-crash-when-`.view-selector`-absent bug
`0c658b6`, among others).

This effort moves the project into a **maintenance phase**: before the
next round of features, systematically enumerate every user-facing
scenario the app supports, map each one to its current automated-test
coverage, and close the gaps — subsystem by subsystem, each
independently shippable.

Concretely, this produces:

1. **A living coverage catalog** (`docs/TEST-COVERAGE.md`) — every
   subsystem, every scenario, its intended test level, and its current
   status (covered / partial / gap). Updated as each phase lands.
2. **Coverage instrumentation** — `@vitest/coverage-v8`, a
   `test:coverage` script, and a CI coverage summary, so the catalog's
   gap analysis has a real line/branch baseline alongside the
   scenario-level view.
3. **A phased implementation plan** (written separately via the
   `writing-plans` skill, once this spec is approved) — one phase per
   subsystem, each closing that subsystem's gaps in one PR.

## Non-goals

- **No test-framework migration or churn on passing tests.** Vitest
  (two projects: `unit`, `components`) + Playwright (two projects:
  `local`, `collab`) stay exactly as configured in `vitest.config.ts`
  and `playwright.config.ts`. Existing passing tests are not rewritten,
  re-levelled, or reorganized unless a specific scenario row in the
  catalog is marked "partial — wrong level" and moving it is the fix.
- **No hard coverage threshold in CI as part of this effort.** Phase 0
  adds measurement and a non-blocking summary. Setting a minimum
  line/branch floor is a deliberate follow-up once the real baseline
  number exists — picking a threshold before we know the number just
  invites an arbitrary gate.
- **Not literally exhaustive.** "Every possible use case" is the
  aspiration; the practical target is *thorough per subsystem* —
  every distinct user-facing behavior and every documented past bug
  gets a scenario row, and within each phase the rows are ranked so
  the high-value ones land first. We do **not** enumerate every
  combinatorial product of every setting × every document state ×
  every role × every viewport — that explosion is called out
  explicitly where it's relevant and pruned to representative cases.
- **No visual-regression / screenshot-diff testing.** That's new infra
  (baseline management, cross-platform rendering tolerance) and a
  separate bet. Playwright's existing `screenshot: "only-on-failure"`
  debugging aid stays; nothing asserts on pixels.
- **No performance, load, or concurrency-stress testing of the Durable
  Objects.** Correctness scenarios for collab (convergence, migration,
  role enforcement) are in scope; "1000 simultaneous editors" is not.
- **No new live-infrastructure test harness.** Worker/DO scenarios use
  the existing fakes (`src/test-support/fake-github-server.ts`, the
  in-memory fs shim, `tests/e2e/collab/support/dev-login.ts`) and the
  existing `tests/scripts/e2e-collab.sh` real-Worker path. Nothing new
  stood up.
- **No changes to application behavior**, except bugfixes that fall out
  of writing the tests — and those follow the bundling rule below, not
  a licence to refactor.

## Architecture

### The catalog document

`docs/TEST-COVERAGE.md` — committed, human-maintained, updated in the
same PR as each phase's test work. Structure:

- A short preamble: how to read it, the level definitions, the status
  definitions, and the rule that every new user-facing behavior (and
  every fixed bug) adds a row here.
- One `##` section per subsystem (the 14 below), in the fixed order
  used by the phase plan.
- Each section is a table:

  | Column | Meaning |
  |--------|---------|
  | `ID` | Stable id, `<SUBSYS>-NN` (e.g. `REPO-07`), referenced by test names and commit messages |
  | `Scenario` | One user-facing behavior, stated as an observable outcome ("Deleting a repo-linked doc removes it from the repo on next push"), not an implementation detail |
  | `Level` | `unit` / `component` / `integration` / `e2e` / `e2e-collab` — the level this scenario *should* be tested at |
  | `Status` | `covered` / `partial` / `gap` |
  | `Test` | File path (+ test name where useful) of the covering test, or `—` |
  | `Notes` | Why partial, links to the originating bug commit, pruning rationale, deferral reason |

- A trailing `## Deferred` section: scenarios deliberately not tested
  and why (mirrors `ROADMAP.md`'s deferred-items convention), plus any
  `test.fixme`/`it.skip` rows pointing at real bugs awaiting a fix
  branch.

### Level definitions (used consistently across the catalog)

- **unit** — a pure function or store in isolation, no DOM, jsdom or
  none. `tests/client/src/*.test.ts`, `tests/src/*.test.ts`.
- **component** — a single `.svelte` file mounted in real headless
  Chromium via `vitest-browser-svelte`. `tests/client/src/components/*.test.ts`.
- **integration** — the Worker / a Durable Object exercised in-process
  with network dependencies faked (GitHub API, git smart-HTTP). No
  browser. `tests/src/*.test.ts`.
- **e2e** — the full built client in a browser, no Worker (or a stub
  404 `/api`). `tests/e2e/local/*.spec.ts`.
- **e2e-collab** — the full client against a real `wrangler dev` Worker
  with real Durable Objects and dev-login auth. `tests/e2e/collab/*.spec.ts`.

The catalog assigns each scenario the **cheapest level that actually
exercises the real risk**. A scenario that is a pure transform
(wikilink rewrite, diff line computation, session grouping) is `unit`
even if a user experiences it through the editor. A scenario whose risk
*is* the browser integration (CodeMirror selection math, drag-and-drop,
focus management, scroll sync, mobile touch) stays `e2e`.

### Coverage instrumentation

- `@vitest/coverage-v8` added as a devDependency (matches the V8
  engine both Vitest projects already run on; no Istanbul
  instrumentation overhead).
- `package.json`: `"test:coverage": "vitest run --coverage"`. Both
  projects (`unit` + `components`) report; the `components` project's
  browser-mode coverage is collected via the Playwright provider's V8
  support. Config in `vitest.config.ts` under `test.coverage`:
  `provider: "v8"`, `reporter: ["text-summary", "html", "json"]`,
  `include: ["client/src/**", "src/**"]`,
  `exclude: ["**/*.d.ts", "client/src/vite-env.d.ts", "**/test-support/**"]`,
  `reportsDirectory: "coverage/"` (gitignored).
- `.github/workflows/test.yml`: after the existing `npm test` step, a
  `npm run test:coverage` run (or fold `--coverage` into the existing
  run) that prints the `text-summary` to the job log and uploads the
  `html` report as a build artifact. **No `thresholds` block, no
  `--coverage.thresholds.autoUpdate`** — non-blocking this round.
- Playwright e2e coverage is **not** merged into the same report in
  this effort — collecting V8 coverage across the Playwright projects
  and reconciling it with the Vitest report is disproportionate setup
  for a number we're not gating on. The catalog's `e2e`/`e2e-collab`
  rows carry the coverage signal for those paths instead.

### Subsystems (fixed order — phase order)

| # | Subsystem | Primary source |
|---|-----------|----------------|
| 1 | Editor core & formatting | `app.ts`, `formatting-commands.ts`, `Editor.svelte`, `Toolbar.svelte` |
| 2 | Preview, scroll-sync & rendering | `Preview.svelte`, `scroll-sync.ts`, `math-preview.ts`, `mermaid-preview.ts`, `diagram-export.ts`, `diagram-refs.ts`, `DiagramEditor.svelte` |
| 3 | Markdown dialects | `wikilinks.ts`, `wikilink-rewrite.ts`, `wikilink-rename-cascade.ts`, `mmd-citations.ts`, `mmd-metadata.ts`, `mmd-inline-blocks.ts`, `markdown-compat.ts` |
| 4 | Documents, workspaces & multi-tab | `stores/docs.ts`, `stores/workspaces.ts`, `merge-records.ts`, `router.ts`, `doc-naming.ts`, `DocList.svelte`, `WorkspaceSwitcher.svelte` |
| 5 | Images | image paste/drop/pick in `app.ts`, `image-key.ts`, `ImagesModal.svelte` |
| 6 | Export & print | export logic in `app.ts` |
| 7 | Find & replace / search | `search.ts`, `fuzzy-match.ts`, `stores/findReplace.ts`, `FindReplaceBar.svelte` |
| 8 | Version history & diff view | `version-grouping.ts`, `history.ts`, `version-preview.ts`, `version-grouping.ts`, `diff-lines.ts`, `diff-image-row.ts`, `VersionHistory.svelte`, `DiffView.svelte` |
| 9 | Comments | `comments.ts`, `CommentsPanel.svelte`, `stores/commentsPanel.ts`, `stores/commentDraft.ts`, comment routes in `src/workspace-room.ts` |
| 10 | Workspace collab | `collab.ts`, `src/workspace-room.ts`, `src/collab-room.ts`, `suggestions.ts`, `src/suggestions.ts`, `suggestion-editor.ts`, `suggestion-preview.ts`, `src/access-role.ts`, `src/access-visibility.ts`, `stores/workspacePresence.ts` |
| 11 | GitHub auth & Gist | `src/github-auth.ts`, `src/auth.ts`, `src/env.ts`, `gist.ts`, `src/gist-images.ts`, `src/memory-fs.ts` |
| 12 | GitHub repo sync | `repo-sync.ts`, `repo-sync-ui.ts`, `src/github-repo.ts`, `repo-history-sync.ts`, `repo-doc-dates.ts` |
| 13 | Mobile | mobile layout/branches in `app.ts` + components (bottom sheets, tab switcher, toolbar overflow, input-zoom, scroll sync) |
| 14 | App shell | `MenuBar.svelte`, `CommandPalette.svelte`, `Modal.svelte`, `stores/toast.ts`, `whats-new.ts`, `whats-new-entries.ts`, `WhatsNew.svelte`, `focus-mode.ts`, `debounce.ts`, `relative-time.ts`, `anchor.ts`, `escape-html.ts`, `router.ts` (shell wiring), `worker.ts` static-serving/routing fallthrough |

`worker.ts`'s own routing/dispatch and the `access-role` / `access-visibility`
helpers are covered where their consumers are (10–12), not as a
standalone phase.

## Components (of the work)

### Phase 0 — instrumentation + catalog (first PR)

1. Add `@vitest/coverage-v8`; `test:coverage` script; `test.coverage`
   config block; `coverage/` in `.gitignore`.
2. CI: coverage run + `text-summary` to log + `html` artifact upload,
   non-blocking.
3. Author `docs/TEST-COVERAGE.md` in full — all 14 sections, every
   scenario row, every current status determined by actually reading
   the source and the existing tests (not guessed). This is the bulk
   of the phase.
4. Commit this design spec + the catalog together (`docs: test
   coverage catalog and instrumentation`).
5. `package.json` + `package-lock.json` patch bump; `CHANGELOG.md`
   `### Added` entry ("Test coverage catalog (`docs/TEST-COVERAGE.md`)
   and `npm run test:coverage`"). No `whats-new-entries.ts` entry
   (behind-the-scenes).

### Phases 1–13 — one subsystem each

For subsystem *N* (in the fixed order above):

1. Re-read that subsystem's catalog section; confirm every row's
   status against current `master` (phases before it may have shifted
   things).
2. For each `gap` and `partial` row worth closing: write the test at
   the assigned level. TDD where the scenario admits it (the test is
   written to pass against current correct behavior; for a
   documented-bug row the test is written to fail, then see bundling
   rule).
3. Update the catalog rows to `covered` with the new test path.
4. Any row deliberately left un-closed moves to the catalog's
   `## Deferred` block with a reason.
5. Patch bump + `CHANGELOG.md` `### Changed` ("Expanded automated test
   coverage for <subsystem>"). No `whats-new` entry.
6. One PR. If the phase's test work exceeds ~1 day / ~15 new test
   cases, split into `Na` / `Nb` along a natural seam (e.g. 10a =
   WorkspaceRoom integration, 10b = collab.ts client + e2e-collab) and
   say so in the plan — never silently.

### Bugs found while writing tests

- **Trivial** (one-file, obvious, low-blast-radius — the kind
  `IMPROVEMENTS.md` Phase 1 describes): fix it in the same phase PR,
  with the failing-then-passing regression test. Note the fix in that
  PR's `CHANGELOG.md` `### Fixed`.
- **Non-trivial** (touches multiple files, unclear root cause, a
  design question, or any collab/sync/data-loss path): add the test as
  `it.skip` / `test.fixme` with a `// BUG: <description>` comment and a
  catalog `## Deferred` row, and flag it to the user for a separate
  brainstorm→plan→fix branch. Do not fix it inline.
- The bundling decision is the user's to confirm per-bug when it's a
  close call — surface it, recommend, wait.

## Data flow (how a scenario becomes a test)

```
Read source + existing tests for subsystem N
        │
        ▼
Enumerate scenarios  ──►  catalog row (ID, scenario, level, status=gap|partial|covered)
        │
        ▼ (per gap/partial row, in phase N)
Pick cheapest level that exercises the real risk
        │
        ├─ pure logic ................ tests/client/src/*.test.ts | tests/src/*.test.ts
        ├─ one component ............. tests/client/src/components/*.test.ts
        ├─ Worker / DO + fakes ....... tests/src/*.test.ts
        ├─ full client, no Worker .... tests/e2e/local/*.spec.ts
        └─ full client + real Worker . tests/e2e/collab/*.spec.ts
        │
        ▼
Write test → passes (or fails→bundled fix→passes, or skip+defer)
        │
        ▼
Catalog row → covered (+ test path)   │   CHANGELOG ### Changed   │   patch bump   │   PR
```

## Testing (of this effort itself)

- Phase 0's instrumentation is verified by `npm run test:coverage`
  producing a non-empty `text-summary` and an `html` report locally,
  and the CI job attaching the artifact on a PR.
- Every phase is gated by the existing full CI (`npm test`,
  `npm run build`, `npm run typecheck`, `npm run format:check`,
  Playwright `local`) going green, plus a local
  `npm run test:e2e:collab` run for phases 9, 10, and any other phase
  that adds an `e2e-collab` spec.
- The catalog is "tested" by review: Phase 0's PR review is where the
  user confirms the scenario enumeration is complete enough and the
  status column is accurate.

## Versioning

Every phase is behind-the-scenes (tests, instrumentation, docs; any
bundled bugfix has no new user-facing capability). Per `CLAUDE.md`:
**patch bump** (`1.X.Y` → `1.X.Y+1`) in `package.json` +
`package-lock.json` (both `version` fields, hand-edited), a
`CHANGELOG.md` entry (`### Added` for Phase 0, `### Changed` /
`### Fixed` for phases 1–13), and **no `whats-new-entries.ts` entry**.
Each phase merges independently and auto-tag/release handles the rest.

## Review prompts (a default is chosen for each; override if wanted)

1. **Phase granularity** — default: 14 phases (0 + 13), one per
   subsystem. Alternative: merge small adjacent ones (5 Images + 6
   Export; or dissolve 13 Mobile into each desktop subsystem's phase).
2. **Catalog location** — default: `docs/TEST-COVERAGE.md` (top-level,
   discoverable). Alternative: `docs/superpowers/` alongside specs and
   plans.
3. **Large phases (10 collab, 12 repo sync)** — default: decide the
   `Na`/`Nb` split at execution time and flag it in that phase's PR.
   Alternative: pre-split in the written plan.
