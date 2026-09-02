# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run build              # vite build (client) -> client/dist
npm run dev                 # wrangler dev, serves client/dist + the Worker (auth/collab/gist/repo APIs) — does NOT rebuild the client
npm run dev:client          # plain Vite dev server, client-only, no Worker/collab/auth/Gist endpoints

npm test                    # vitest run — whole suite (both projects below)
npx vitest run tests/client/src/collab.test.ts          # single file
npx vitest run -t "seeds the shared doc's current name"  # single test by name
npx vitest run --project=components                      # just the Svelte component tests

npm run typecheck            # tsc --noEmit (root/server, strict) && svelte-check --tsconfig client/tsconfig.json (client)
npm run format               # prettier --write .
npm run format:check

npm run test:e2e:local       # Playwright, client-only flows (formatting, export, focus mode, etc.)
npm run test:e2e:collab      # bash tests/scripts/e2e-collab.sh — spins up a real Worker, exercises live collaboration
npm run test:e2e             # both, sequentially
```

`npm run dev` serves whatever is currently built into `client/dist` — re-run `npm run build` (or run `vite build --config client/vite.config.ts --watch` in a second terminal) after client-side changes before testing against the Worker. GitHub sign-in / Gist / repo-sync need a real OAuth App (`GITHUB_CLIENT_SECRET`/`SESSION_SECRET` in a git-ignored `.dev.vars`, see CONTRIBUTING.md) — everything else (local editing, multi-doc, export, sharing between two tabs on one machine) works without one.

There are **two separate `tsconfig.json`s**, checked separately: the root one (`src/**`, `tests/src/**`) is full strict mode; `client/tsconfig.json` (`client/src/**`, `tests/client/src/**`) has `strictNullChecks`/`noImplicitAny` off — deliberately, see that file's own comment (a DOM-heavy vanilla-JS core mid-migration into Svelte components; don't "fix" this by re-enabling strictness repo-wide).

`vitest.config.ts` defines **two Vitest projects**, both run by a plain `npm test`: `unit` is the original Node/jsdom suite; `components` mounts real `.svelte` files with `vitest-browser-svelte` in an actual headless Chromium (via `@vitest/browser-playwright`), not jsdom — Svelte 5's compiled output needs a real browser to run faithfully. Component test files go under `tests/client/src/components/*.test.ts` specifically (that's what routes them to the `components` project instead of `unit`). A failed component test auto-saves a screenshot to `tests/client/src/components/__screenshots__/` (gitignored) — check it first when one fails.

## Architecture

Client (TypeScript + Svelte 5 + Vite) and backend (a single Cloudflare Worker, also TypeScript) in one repo, no database. Documents are `localStorage`-only until shared; a shared workspace's live state lives entirely in a Durable Object.

### The `window.MDE` bridge

`client/src/app.ts` owns the CodeMirror 6 instance, the DOM, and most menu/toolbar/export logic; it publishes a contract on `window.MDE` (typed as `MDEBridge` in `client/src/types.ts`) that `collab.ts`, `gist.ts`, and Svelte components use to reach the editor/DOM without a circular import back into `app.ts`. Pure state (the doc list, active doc, workspaces) lives in `client/src/stores/*.ts` instead and is imported directly by anything that needs it — `window.MDE` is only for what genuinely requires `app.ts`'s closure (the live `EditorView`, mobile-sidebar DOM state, a preview refresh).

The bridge also carries paired hooks for state that a collaborator can change remotely and the local app must reflect back into the DOM, e.g. `setDocImage`/`onImageAdded` and `setDocName`/`onDocRenamed`: the `set*` direction is `collab.ts` telling `app.ts` "a remote change landed, update the UI"; the `on*` direction is `app.ts` telling `collab.ts` "the local user just changed this, push it out" (set in `collab.ts`'s `init()`, which never runs under `jsdom` in tests — `DOMContentLoaded` has already fired before the module loads there).

### Workspaces, documents, and two generations of Durable Object

`Workspace` (`stores/workspaces.ts`) is the sharing unit, not the document — one active workspace at a time (VS Code-style), documents (`stores/docs.ts`) scoped to it and movable between workspaces. Sharing a workspace links it to a `WorkspaceRoom` Durable Object (`src/workspace-room.ts`, one instance per workspace id) that holds every document's live `Y.Doc` plus non-Yjs metadata (access record, comment threads, version snapshots) in DO storage, relayed over **one WebSocket per workspace** (not per document) — every `MESSAGE_SYNC`/`MESSAGE_AWARENESS` frame is prefixed with a `docId` string so the single connection can multiplex all of a workspace's documents at once. `MESSAGE_PRESENCE` frames carry cross-document "who's looking at what" separately from any one document's own y-protocols `Awareness` instance.

`CollabRoom` (`src/collab-room.ts`) is the **legacy**, one-Durable-Object-per-document predecessor — kept alive only so an old single-document share link still works: `collab.ts`'s `migrateLegacyDoc` transparently migrates it into a fresh `WorkspaceRoom` (via `CollabRoom.handleMigrateRequest` → `WorkspaceRoom`'s internal `/internal/seed` endpoint) the moment such a document is opened, before any live sync attaches. New work should target `WorkspaceRoom`; treat `CollabRoom` as migration-path-only.

A document's per-document `Y.Doc` (client side: `DocBinding` in `collab.ts`) carries more than just its text — `ytext` (content), `imagesMap` (`Y.Map<string>`, pasted/dropped images), and `meta` (`Y.Map<string>`, currently just `name`) are three top-level types on the same doc, all riding the same sync/persistence/broadcast path for free; adding another synced field on an existing shared document is "add another top-level type here," not new server code. Every write to the Y.Doc is gated editor-only server-side (`WorkspaceRoom.handleMessage`'s `isWrite` check) — comments and version restores have their own, more permissive per-endpoint role checks (`viewer`/`reviewer`/`editor`) since they're plain HTTP against DO storage, not Y.Doc updates.

Role for a given connection/request is resolved once, server-side, by `authorize()` in each room class — owner → `editor`; `generalAccess: "anyone"` → the room's configured link role; otherwise the requester's per-username entry in `invited`. The client never has final say over its own role; `collab.ts` mirrors it into the UI (read-only CodeMirror, etc.) as a best-effort UX layer only.

### Everything else server-side

`src/worker.ts` is the single fetch entry point, routing `/api/workspace/*` and `/api/collab/*` to the two DO classes, `/api/auth/github/*` to OAuth (`src/github-auth.ts`, session cookie crypto in `src/auth.ts`), `/api/gist*` to Gist publish/open (images pushed as real git blobs via isomorphic-git — `src/gist-images.ts`, against an in-memory fs shim `src/memory-fs.ts` since there's no real filesystem in a Worker), and `/api/repo/*` to GitHub repo tree/blob/commit/push endpoints (`src/github-repo.ts`) backing workspace-to-repo sync (`client/src/repo-sync.ts`).

### Process: design docs before non-trivial features

`docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md` (a design spec: goal, non-goals/deferred scope, the actual design) and `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` (a numbered, checkbox-tracked implementation plan with literal find/change-to diffs) are written **before** implementing anything beyond a small fix — see `IMPROVEMENTS.md`'s own note that Phase 2+ items each get a "brainstorm → plan → ship cycle." Each is normally its own commit (`docs: design spec for X`, then `docs: implementation plan for X`). The `superpowers` plugin (`obra/superpowers`, installed at the user level — `writing-plans`, `executing-plans`, `subagent-driven-development`, `brainstorming`, etc.) is the tooling this convention is modeled on.

**Always take the full spec + plan (Architectural) path for any IMPROVEMENTS.md backlog item or other new feature, even one the `brainstorming` skill's own criteria would call "Bounded."** This repo's convention overrides that skill's shortcut: don't skip the written spec/plan just because a change touches only one or two existing files or looks well-scoped in chat — write the spec, self-review it, get it approved, then write the implementation plan, for every feature-sized unit of work. Reserve the no-spec/no-plan path for genuinely small fixes (a one-file bug fix, a copy tweak, a config change) that IMPROVEMENTS.md itself would file under Phase 1, not Phase 2+.

### Versioning and release notes — three places move together

A change that ships anything **user-facing** bumps the **minor** version (`1.X.0` in `package.json`, mirrored in `package-lock.json`'s two `"version"` fields — hand-edit both rather than a full `npm install --package-lock-only` regeneration, which can pull in unrelated lockfile metadata churn) and needs all three of:

1. `package.json` (+ `package-lock.json`) version bump
2. A new `## [1.X.0] - YYYY-MM-DD` section at the top of `CHANGELOG.md` (Keep a Changelog format — `### Added`/`### Changed`/`### Fixed`)
3. A new entry appended to `client/src/whats-new-entries.ts` (`WHATS_NEW_ENTRIES`, oldest-first) — `WhatsNew.svelte` warns in dev if the last entry's version doesn't match `__APP_VERSION__` (from `package.json` via Vite `define`), though a `screenshot` field pointing at a real asset is expected too

A change that's **purely behind-the-scenes** (internal refactor, dependency bump, a bugfix with no visible behavior change beyond "the bug is gone") bumps only the **patch** version (`1.0.X`) and gets a `CHANGELOG.md` entry (`### Fixed`/`### Changed`) but **no** `whats-new-entries.ts` entry. Tags trigger `.github/workflows/release.yml`, which pulls that tag's `CHANGELOG.md` section verbatim into the GitHub Release notes (`.github/scripts/release-helper.cjs`) — an untagged version bump with no changelog section produces an empty release note.

### Shipping a change: PR, merge — tag, release, and deploy all happen on their own

Once a change (with its version/CHANGELOG/whats-new updates, per above) is ready:

1. Push the branch and open a PR against `master` (`.github/workflows/test.yml` runs `npm test`, `npm run build`, `npm run typecheck`, `npm run format:check`, and the local Playwright e2e suite on every PR).
2. Wait for CI to go green before merging — don't merge on red or unfinished checks.
3. Merge the PR (this repo's history uses a real merge commit — GitHub's "Merge pull request #N from ..." — not squash/rebase).
4. **That's it — nothing else to do by hand.** `.github/workflows/auto-tag.yml` runs on every push to `master`: it tags the merge commit `vX.Y.Z` from whatever `package.json`'s version currently is (skipping if that tag already exists), then explicitly triggers `release.yml` via `workflow_dispatch` — a plain `git push` of the tag using the workflow's own token wouldn't fire `release.yml`'s tag-push trigger on its own, since GitHub doesn't chain workflow runs off a `GITHUB_TOKEN`-authored push. `release.yml`'s `release-helper.cjs` then cuts the GitHub Release from that tag's `CHANGELOG.md` section — and if an earlier version's own bump got superseded before its branch ever merged on its own (no commit anywhere ever had that exact `package.json` version — it happens; see ROADMAP.md's v1.40.3/v1.41.0 entries), `extractChangelog` automatically folds that orphaned section into the release that actually shipped it, walking backward from a tag through older sections until it hits one that has a real tag of its own.
   - The one gap auto-tag can't close: a commit that itself modifies a `.github/workflows/*` file can't be tagged by `GITHUB_TOKEN` (no permission scope allows it) — auto-tag.yml skips that one version with a `::warning::` rather than failing the whole batch. Needs a PAT with the `workflow` scope to ever close, which isn't currently set up.
5. **No separate deploy step.** Cloudflare is already wired to auto-deploy from this GitHub repo on pushes to `master` — merging the PR is the deploy. `npm run deploy` (`wrangler deploy`) exists for manual/local use only; don't run it as part of normal shipping.
