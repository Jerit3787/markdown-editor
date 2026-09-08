# Collaboration mode chrome v2 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared-workspace collaborator chrome match Google Docs — version history is an editing-mode-only tool, the Edit menu condenses in Viewing instead of vanishing, Share and comments grey out for people who can't use them, and deleting a document is owner-only.

**Architecture:** Every gate keys off `$effectiveMode` (`stores/collabMode.ts`), with two role predicates (`nonEditorCollaborator`, `canDeleteDoc`) for Share and Delete. The three topbar buttons that `app.ts` currently disables imperatively for the empty state (`#shareBtn`, `#versionHistoryBtn`, `#commentsBtn`) move to Svelte `$effect`s in their always-mounted owning components, which now compute `noActiveDoc || <mode/role condition>` in one place. No new store, bridge method, or server change.

**Tech Stack:** Svelte 5 (`$derived` / `$effect`), Vitest (`unit` + `components`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-collab-chrome-v2-design.md`

## Global Constraints

- **Continue on branch `docs/collab-chrome-v2-spec`** (holds the spec; PR #185). Rename the PR in the final task.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. PR body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Never `git add src/worker.ts`** — no server change here; `git status` before every `git add`.
- **Version bump is the final task**, not before (per `CLAUDE.md`).
- `feedback_topbar_sizing_locked`: this touches topbar button *disabled state* and one small ModeSwitcher dropdown style — no sizing/colour changes to the locked topbar.
- Predicates (define in `MenuBar.svelte`; the other components derive their own copies):
  ```ts
  const mode = $derived($effectiveMode);            // "editing" | "suggesting" | "viewing" | null
  const viewing     = $derived(mode === "viewing");
  const editingMode = $derived(mode === "editing" || mode == null); // null = plain local doc
  const nonEditorCollaborator = $derived(!!$collabRole && $collabRole !== "editor");
  ```
- Existing v1.50.0 fact: the Edit/Format/Insert menus use the **`hidden` attribute** (not `{#if}`), so `bind:this` refs stay live even when hidden — no null-check work needed (the spec's earlier "restore non-optional" note is moot).

---

## File Structure

**Modify:**
- `client/src/components/MenuBar.svelte` — Edit menu condense; `#menuComments` / `#menuVersionHistory` / `#menuDeleteDoc` disable predicates; own `#shareBtn` / `#shareDropdownBtn` disabled state (moved from `app.ts`).
- `client/src/components/CommentsPanel.svelte` — `#commentsBtn` `disabled` (was `hidden`) in Viewing + own its no-active-doc term.
- `client/src/components/VersionHistory.svelte` — `$effect` disabling `#versionHistoryBtn` unless editing mode; `open()` early-return.
- `client/src/components/ModeSwitcher.svelte` — one-line mode descriptions in the dropdown.
- `client/src/app.ts` — remove the `#shareBtn` / `#shareDropdownBtn` / `#commentsBtn` / `#versionHistoryBtn` lines from `updateMainView`'s empty-state block (now owned by the components).
- `client/src/collab.ts` — `openShareModal()` early-return backstop.
- `client/src/styles/_topbar.scss` (or the ModeSwitcher's stylesheet) — `.mode-switcher-desc`.
- Tests: `tests/client/src/components/MenuBar.test.ts`, `CommentsPanel.test.ts`, `VersionHistory*.test.ts` (or a new one), `ModeSwitcher.test.ts`, `tests/client/src/collab.test.ts`, `tests/e2e/collab/mode-switcher.spec.ts`.
- Release: `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/collab-chrome-v2.png`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`, `package.json`, `package-lock.json`, `tests/scripts/manual-testing/capture-collab-chrome-v2-screenshot.mjs`.

---

## Task 1: MenuBar — Edit menu condense + item gates (CV2-1a, CV2-1b, CV2-3, CV2-4)

**Files:**
- Modify: `client/src/components/MenuBar.svelte`
- Test: `tests/client/src/components/MenuBar.test.ts`

**Interfaces:**
- Consumes: `effectiveMode`, `collabRole`, `collabIsOwner` (already imported from `../stores/collabMode`).
- Produces: `#editMenuBtn` visible in Viewing with only `#menuFind` + `#menuCopy` shown; `#menuComments` `disabled` in Viewing; `#menuVersionHistory` `disabled` unless editing mode; `#menuDeleteDoc` `disabled` unless owner + editing.

- [ ] **Step 1: Update the failing test — `MenuBar.test.ts` "A3"** (line ~79)

Replace the `A3` test with:

```ts
test("CV2-1: Viewing condenses the Edit menu (keeps Find/Copy) and hides Format/Insert; Suggesting keeps all three", async () => {
  const screen = await render(MenuBar);
  const hidden = (sel: string) => screen.container.querySelector(sel)?.hasAttribute("hidden");

  // editing / local — everything present
  expect(hidden("#editMenuBtn")).toBe(false);
  expect(hidden("#menuUndo")).toBe(false);

  enterCollabRoom("r1", "viewer", false); // → viewing
  await expect.poll(() => hidden("#formatMenuBtn")).toBe(true);
  expect(hidden("#insertMenuBtn")).toBe(true);
  expect(hidden("#editMenuBtn")).toBe(false); // Edit menu stays, condensed
  expect(hidden("#menuFind")).toBe(false);
  expect(hidden("#menuCopy")).toBe(false);
  expect(hidden("#menuUndo")).toBe(true);
  expect(hidden("#menuRedo")).toBe(true);
  expect(hidden("#menuFindReplace")).toBe(true);
  expect(hidden("#menuCut")).toBe(true);
  expect(hidden("#menuPaste")).toBe(true);

  enterCollabRoom("r2", "reviewer", false); // → suggesting (a reviewer's default)
  await expect.poll(() => hidden("#formatMenuBtn")).toBe(false);
  expect(hidden("#insertMenuBtn")).toBe(false);
  expect(hidden("#menuUndo")).toBe(false);
});

test("CV2-1b: #menuComments is disabled (not hidden) in Viewing, enabled in Suggesting/Editing", async () => {
  const screen = await render(MenuBar);
  const el = () => screen.container.querySelector("#menuComments") as HTMLButtonElement;
  expect(el().disabled).toBe(false);
  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => el().disabled).toBe(true);
  expect(el().hasAttribute("hidden")).toBe(false);
  enterCollabRoom("r2", "reviewer", false);
  await expect.poll(() => el().disabled).toBe(false);
});

test("CV2-3: #menuVersionHistory is enabled only when effective mode is editing (or a plain local doc)", async () => {
  const screen = await render(MenuBar);
  const el = () => screen.container.querySelector("#menuVersionHistory") as HTMLButtonElement;
  expect(el().disabled).toBe(false); // local
  enterCollabRoom("r1", "editor", true);
  setChosenMode("suggesting");
  await expect.poll(() => el().disabled).toBe(true); // editor, but suggesting
  setChosenMode("viewing");
  await expect.poll(() => el().disabled).toBe(true);
  setChosenMode("editing");
  await expect.poll(() => el().disabled).toBe(false);
  enterCollabRoom("r2", "viewer", false);
  await expect.poll(() => el().disabled).toBe(true);
});

test("CV2-4: #menuDeleteDoc is enabled only for owner-in-editing (or a plain local doc)", async () => {
  const screen = await render(MenuBar);
  const el = () => screen.container.querySelector("#menuDeleteDoc") as HTMLButtonElement;
  expect(el().disabled).toBe(false); // local
  enterCollabRoom("r1", "editor", false); // non-owner editor
  await expect.poll(() => el().disabled).toBe(true);
  enterCollabRoom("r2", "editor", true); // owner
  setChosenMode("editing");
  await expect.poll(() => el().disabled).toBe(false);
  setChosenMode("viewing");
  await expect.poll(() => el().disabled).toBe(true);
});
```

Add `setChosenMode` to the `collabMode` import at the top of the test file.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts -t "CV2"`
Expected: FAIL.

- [ ] **Step 3: Implement — predicates**

`MenuBar.svelte` script, after the existing `viewing` / `publishHidden` derives (line ~18):

```ts
  const mode = $derived($effectiveMode);
  const editingMode = $derived(mode === "editing" || mode == null);
  const nonEditorCollaborator = $derived(!!$collabRole && $collabRole !== "editor");
  const canDeleteDoc = $derived((!$collabRole || $collabIsOwner) && editingMode);
```

(`viewing` already exists as `$derived($effectiveMode === "viewing")`.)

- [ ] **Step 4: Implement — Edit menu**

- The Edit `<div class="dropdown" hidden={viewing}>` (line ~230) → `<div class="dropdown">`.
- `<button bind:this={editMenuBtn} id="editMenuBtn" ... hidden={viewing}>` → drop `hidden={viewing}`.
- Add `hidden={viewing}` to: `#menuUndo`, `#menuRedo`, `#menuFindReplace`, `#menuCut`, `#menuPaste`, **and** the two `<div class="menu-divider">` at lines ~235 and ~238 (the one after `#menuRedo` and the one after `#menuFindReplace`).
- Leave `#menuFind` and `#menuCopy` exactly as they are.
- Format and Insert `<div class="dropdown" hidden={viewing}>` + their triggers — unchanged (keep `hidden={viewing}`).

- [ ] **Step 5: Implement — the three File-menu items**

- `#menuComments` (line ~206): `hidden={viewing}` → `disabled={viewing || !hasActiveDoc}`.
- `#menuVersionHistory` (line ~214): `disabled={!hasActiveDoc}` → `disabled={!editingMode || !hasActiveDoc}`.
- `#menuDeleteDoc` (line ~224): `disabled={!hasActiveDoc}` → `disabled={!canDeleteDoc || !hasActiveDoc}`.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts` — PASS
Run: `npm run typecheck` — clean

- [ ] **Step 7: Commit**

```bash
git add client/src/components/MenuBar.svelte tests/client/src/components/MenuBar.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): Edit menu condenses in Viewing; version-history / delete gated by mode + role (CV2-1/3/4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `#commentsBtn` — greyed in Viewing, owns its empty-state (CV2-1b)

**Files:**
- Modify: `client/src/components/CommentsPanel.svelte`, `client/src/app.ts`
- Test: `tests/client/src/components/CommentsPanel.test.ts`

**Interfaces:**
- Consumes: `effectiveMode` (already imported), `activeIdStore` (`../stores/docs`) — add the import.
- Produces: `#commentsBtn` gets `disabled` (not `hidden`) from `noActiveDoc || viewing`; `app.ts` no longer touches `#commentsBtn.disabled`.

- [ ] **Step 1: Write the failing test — `CommentsPanel.test.ts`**

```ts
test("CV2-1b: #commentsBtn is disabled (not hidden) in Viewing and when there is no active doc", async () => {
  const btn = document.createElement("button");
  btn.id = "commentsBtn";
  document.body.appendChild(btn);
  activeIdStore.set("d1");
  leaveCollabRoom();
  await render(CommentsPanel);

  await expect.poll(() => btn.disabled).toBe(false);
  expect(btn.hasAttribute("hidden")).toBe(false);

  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => btn.disabled).toBe(true);
  expect(btn.hasAttribute("hidden")).toBe(false);

  enterCollabRoom("r2", "reviewer", false);
  await expect.poll(() => btn.disabled).toBe(false);

  activeIdStore.set(null);
  await expect.poll(() => btn.disabled).toBe(true);
});
```

(Match the file's existing mount/import pattern — it already imports `effectiveMode`; add `activeIdStore` from `../../../../client/src/stores/docs` and `enterCollabRoom`/`leaveCollabRoom` from `collabMode`.)

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/CommentsPanel.test.ts -t "CV2-1b"` — FAIL

- [ ] **Step 3: Implement — `CommentsPanel.svelte`**

Add import: `import { activeIdStore } from "../stores/docs";`

Replace the A4 `$effect` (the one toggling `hidden`):

```ts
  // CV2-1b — Viewing mode has no comments surface: grey the topbar button
  // and force the panel shut. Also owns the button's no-active-doc
  // disabled state (moved out of app.ts's empty-state handler).
  $effect(() => {
    const disabled = !$activeIdStore || $effectiveMode === "viewing";
    document.getElementById("commentsBtn")?.toggleAttribute("disabled", disabled);
    if ($effectiveMode === "viewing") commentsPanelOpen.set(false);
  });
```

- [ ] **Step 4: Implement — `app.ts`**

In `updateMainView`'s empty-state block (~line 437), delete:
```ts
    (document.getElementById("commentsBtn") as HTMLButtonElement).disabled = empty;
```

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npx vitest run --project=components tests/client/src/components/CommentsPanel.test.ts` — PASS
Run: `npm run typecheck` — clean
Run: `npm run build` — succeeds

- [ ] **Step 6: Commit**

```bash
git add client/src/components/CommentsPanel.svelte client/src/app.ts tests/client/src/components/CommentsPanel.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): comments button greys in Viewing; owns its empty-state disable (CV2-1b)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `#versionHistoryBtn` — greyed unless editing mode (CV2-3)

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`, `client/src/app.ts`
- Test: new `tests/client/src/components/VersionHistoryModeGate.test.ts` (mounting the full `VersionHistory.svelte` may be heavy — if so, a small unit test on the predicate, see fallback)

**Interfaces:**
- Consumes: `effectiveMode` (`../stores/collabMode`), `activeIdStore` (`../stores/docs`) — add imports.
- Produces: `#versionHistoryBtn` `disabled` from `noActiveDoc || !editingMode`; `open()` no-ops unless editing/local; `app.ts` no longer touches `#versionHistoryBtn.disabled`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { activeIdStore, docsStore } from "../../../../client/src/stores/docs";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { enterCollabRoom, leaveCollabRoom, setChosenMode } from "../../../../client/src/stores/collabMode";
import { get } from "svelte/store";

beforeEach(() => {
  leaveCollabRoom();
  versionHistoryOpen.set(false);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  document.body.querySelector("#versionHistoryBtn")?.remove();
  const btn = document.createElement("button");
  btn.id = "versionHistoryBtn";
  document.body.appendChild(btn);
  docsStore.set([{ id: "d1", name: "D", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("d1");
});

test("CV2-3: #versionHistoryBtn disabled unless effective mode is editing; open() no-ops otherwise", async () => {
  const btn = () => document.getElementById("versionHistoryBtn") as HTMLButtonElement;
  await render(VersionHistory);
  await expect.poll(() => btn().disabled).toBe(false); // local

  enterCollabRoom("r1", "editor", true);
  setChosenMode("viewing");
  await expect.poll(() => btn().disabled).toBe(true);
  btn().click();
  expect(get(versionHistoryOpen)).toBe(false); // open() early-returned

  setChosenMode("editing");
  await expect.poll(() => btn().disabled).toBe(false);
});
```

If mounting `VersionHistory.svelte` fails (heavy imports / `window.MDE`), **fallback:** skip the mount, and instead unit-test a tiny extracted helper `versionHistoryAvailable(mode: Mode | null): boolean` in `client/src/components/` or `stores/collabMode.ts` and assert `MenuBar` + a hand-rolled effect use it. Prefer the component test.

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement — `VersionHistory.svelte`**

Add imports: `import { effectiveMode } from "../stores/collabMode";` `import { activeIdStore } from "../stores/docs";`

Add a helper + guard `open()`:

```ts
  const editingMode = $derived($effectiveMode === "editing" || $effectiveMode == null);

  $effect(() => {
    const disabled = !$activeIdStore || !editingMode;
    document.getElementById("versionHistoryBtn")?.toggleAttribute("disabled", disabled);
  });
```

In `open()` (the `const open = () => versionHistoryOpen.set(true);` in `onMount`, and wherever `MenuBar` calls `versionHistoryOpen.set(true)` is separately guarded by Task 1's `disabled`), change the topbar `open`:

```ts
    const open = () => {
      if (get(effectiveMode) != null && get(effectiveMode) !== "editing") return;
      versionHistoryOpen.set(true);
    };
```

(`get` is already imported in this file.)

- [ ] **Step 4: Implement — `app.ts`**

Delete from `updateMainView` (~line 438):
```ts
    (document.getElementById("versionHistoryBtn") as HTMLButtonElement).disabled = empty;
```

- [ ] **Step 5: Run tests + typecheck + build** — all green

- [ ] **Step 6: Commit**

```bash
git add client/src/components/VersionHistory.svelte client/src/app.ts tests/client/src/components/VersionHistoryModeGate.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): version history is an editing-mode tool — greyed in Suggesting/Viewing (CV2-3)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Share button — greyed & inert in Viewing / for non-editors (CV2-2)

**Files:**
- Modify: `client/src/components/Share.svelte`, `client/src/app.ts`, `client/src/collab.ts`
- Test: `tests/client/src/components/Share.test.ts` (extend), `tests/client/src/collab.test.ts` (extend)

**Interfaces:**
- Consumes: `effectiveMode`, `collabRole` (`../stores/collabMode`), `activeIdStore` (`../stores/docs`) — add to `Share.svelte`.
- Produces: `#shareBtn` / `#shareDropdownBtn` `disabled` from `noActiveDoc || viewing || nonEditorCollaborator`; `title` set to the access summary when greyed; `openShareModal()` backstop; `app.ts` no longer touches these two.

- [ ] **Step 1: Write the failing tests**

`Share.test.ts`:

```ts
test("CV2-2: #shareBtn / #shareDropdownBtn disabled in Viewing or for a viewer/reviewer; enabled for editor / owner / local", async () => {
  for (const id of ["shareBtn", "shareDropdownBtn"]) {
    if (!document.getElementById(id)) {
      const b = document.createElement("button");
      b.id = id;
      document.body.appendChild(b);
    }
  }
  activeIdStore.set("d1");
  leaveCollabRoom();
  await render(Share);
  const btn = () => document.getElementById("shareBtn") as HTMLButtonElement;

  await expect.poll(() => btn().disabled).toBe(false); // local

  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => btn().disabled).toBe(true);
  expect((document.getElementById("shareDropdownBtn") as HTMLButtonElement).disabled).toBe(true);

  enterCollabRoom("r2", "reviewer", false);
  await expect.poll(() => btn().disabled).toBe(true);

  enterCollabRoom("r3", "editor", false); // non-owner editor keeps it (in editing/suggesting)
  await expect.poll(() => btn().disabled).toBe(false);

  setChosenMode("viewing");
  await expect.poll(() => btn().disabled).toBe(true); // editor, but Viewing

  setChosenMode("editing");
  activeIdStore.set(null);
  await expect.poll(() => btn().disabled).toBe(true); // no active doc
});
```

`collab.test.ts` (in the existing "collab-mode role publishing" describe or a new one): after `enterCollabRoom(..., "viewer", ...)` and setting `window.MDE`, call `openShareModal()` and assert `get(shareModalOpen)` stays `false`.

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement — `Share.svelte`**

Add imports: `import { effectiveMode, collabRole } from "../stores/collabMode";` `import { activeIdStore } from "../stores/docs";`

Add an `$effect`:

```ts
  // CV2-2 — Share is greyed & inert in Viewing mode and for a viewer /
  // reviewer (Google Docs parity). An editor keeps it in Editing /
  // Suggesting. Also owns the button's no-active-doc disable (moved out
  // of app.ts). CV2-5 ("Request edit access") will attach to the
  // nonEditorCollaborator branch.
  $effect(() => {
    const nonEditor = !!$collabRole && $collabRole !== "editor";
    const disabled = !$activeIdStore || $effectiveMode === "viewing" || nonEditor;
    for (const id of ["shareBtn", "shareDropdownBtn"]) {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el) el.toggleAttribute("disabled", disabled);
    }
    // keep the current-access summary reachable on hover while greyed
    const btn = document.getElementById("shareBtn");
    if (btn && disabled && access.owner) btn.title = shareAccessSummary(); // see below
    else if (btn) btn.removeAttribute("title");
  });
```

`shareAccessSummary()` — reuse whatever string `Share.svelte` already computes for the dialog's access description (the `ROLE_VERBS[...]` / "Only people with access…" line near line 55). If it's inline, extract a tiny `function shareAccessSummary(): string` returning that text. Keep it short.

- [ ] **Step 4: Implement — `app.ts`**

Delete from `updateMainView` (~lines 435–436):
```ts
    (document.getElementById("shareBtn") as HTMLButtonElement).disabled = empty;
    (document.getElementById("shareDropdownBtn") as HTMLButtonElement).disabled = empty;
```

- [ ] **Step 5: Implement — `collab.ts` backstop**

In `openShareModal()` (line ~1609), after `await window.MDE.githubSessionReady;` and the sign-in check, add:

```ts
  if (get(effectiveMode) === "viewing" || workspaceRoom.role === "viewer" || workspaceRoom.role === "reviewer") return;
```

Add `effectiveMode` to the `./stores/collabMode` import in `collab.ts` if not already there.

- [ ] **Step 6: Run tests + typecheck + build** — all green

- [ ] **Step 7: Commit**

```bash
git add client/src/components/Share.svelte client/src/app.ts client/src/collab.ts tests/client/src/components/Share.test.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): Share button greyed & inert in Viewing and for viewer/reviewer (CV2-2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: ModeSwitcher — one-line mode descriptions (D-modedesc)

**Files:**
- Modify: `client/src/components/ModeSwitcher.svelte`, `client/src/styles/_topbar.scss`
- Test: `tests/client/src/components/ModeSwitcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("D-modedesc: the dropdown shows a one-line description under each mode", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  await screen.getByRole("button", { name: /Editing/ }).click(); // open the dropdown
  expect(screen.container.textContent).toContain("Edit document directly");
  expect(screen.container.textContent).toContain("Edits become suggestions");
  expect(screen.container.textContent).toContain("Read or print final document");
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement — `ModeSwitcher.svelte`**

Add next to `LABELS` / `ICONS`:

```ts
  const DESCRIPTIONS: Record<Mode, string> = {
    editing: "Edit document directly",
    suggesting: "Edits become suggestions",
    viewing: "Read or print final document",
  };
```

In the `{#each $modesAllowed as m}` row, restructure the button contents:

```svelte
        <button type="button" role="menuitem" class="mode-switcher-item dropdown-item" class:active={m === $effectiveMode} onclick={() => pick(m)}>
          <svg class="icon"><use href="#{ICONS[m]}"></use></svg>
          <span class="mode-switcher-item-text">
            <span class="mode-switcher-item-label">{LABELS[m]}</span>
            <span class="mode-switcher-desc">{DESCRIPTIONS[m]}</span>
          </span>
        </button>
```

- [ ] **Step 4: Style — `_topbar.scss`** (near the existing `.mode-switcher-menu` rules)

```scss
.mode-switcher-menu .mode-switcher-item {
  align-items: flex-start;
}
.mode-switcher-menu .mode-switcher-item-text {
  display: flex;
  flex-direction: column;
}
.mode-switcher-menu .mode-switcher-desc {
  font-size: 12px;
  color: var(--text-dim);
}
```

- [ ] **Step 5: Run tests + typecheck + build** — green

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ModeSwitcher.svelte client/src/styles/_topbar.scss tests/client/src/components/ModeSwitcher.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): mode switcher dropdown shows a one-line description per mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Release — 1.X.0

**Files:**
- Modify: `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`
- Create: `tests/scripts/manual-testing/capture-collab-chrome-v2-screenshot.mjs`, `client/public/whats-new/collab-chrome-v2.png`

- [ ] **Step 1: Full local verification**

```bash
npm test
npm run typecheck
npm run format        # re-stage anything it touches
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```
All green; `git diff --quiet src/worker.ts`.

- [ ] **Step 2: e2e — extend `tests/e2e/collab/mode-switcher.spec.ts`**

Add a test: a `viewer`-role collaborator sees the Edit menu open condensed (Find/Copy present, Undo absent), `#versionHistoryBtn` disabled, `#shareBtn` disabled; an owner-editor switched to Suggesting sees the full menu bar but `#versionHistoryBtn` disabled and `#shareBtn` enabled; switched to Viewing, both disabled. (Model on the file's existing `ownerWithDoc` / two-context helpers.)

- [ ] **Step 3: `CHANGELOG.md`**

Next minor from `package.json` (check `git log origin/master` for anything shipped since). Add:

```markdown
## [1.X.0] - <YYYY-MM-DD>

### Changed

- **View-only and suggesting modes now track Google Docs more closely.** Version history is an editing-mode tool — it greys out while you're in Suggesting or Viewing. The Edit menu keeps Find and Copy in Viewing instead of disappearing. Share and the comments button grey out for people who can't use them rather than vanishing. Deleting a document is the workspace owner's call. The mode switcher explains each mode.
```

- [ ] **Step 4: Screenshot**

Create `tests/scripts/manual-testing/capture-collab-chrome-v2-screenshot.mjs` — model on `capture-focus-mode-polish-screenshot.mjs` / the `mode-switcher` e2e's two-browser helpers. Show a **viewer** session: the Edit menu open and condensed (Find + Copy only), with the greyed `#versionHistoryBtn` and `#shareBtn` visible in frame. Save `client/public/whats-new/collab-chrome-v2.png`. Real screenshot — dev-login patch applies + reverts (`enable/disable-dev-login.sh`); verify `git diff --quiet src/worker.ts` after.

- [ ] **Step 5: `whats-new-entries.ts`**

Append (last entry; `version` = new `__APP_VERSION__`):

```ts
  {
    version: "1.X.0",
    title: "A Clearer View-Only Mode",
    description:
      "When you're viewing or suggesting on a shared document, the controls you can't use are greyed out instead of hidden — so the menu still teaches you the interface. Version history is now an editing-mode tool, the Edit menu keeps Find and Copy, and deleting a document is the owner's call.",
    screenshot: "/whats-new/collab-chrome-v2.png",
    category: "Collaboration",
  },
```

- [ ] **Step 6: Version bump**

`package.json` → `1.X.0`; `package-lock.json` both top-level `"version"` fields. Hand-edit.

- [ ] **Step 7: `docs/TEST-COVERAGE.md`**

Update COLLAB-55 ("hidden" → the Edit-menu-condense + comments-greyed wording) and COLLAB-56; add rows: CV2-2 Share gate, CV2-3 version-history mode gate, CV2-4 delete owner-gate, D-modedesc.

- [ ] **Step 8: `ROADMAP.md`**

Under "Collab-mode chrome v2 — disable, don't hide": mark **CV2-1..4 shipped v1.X.0** (PR #185) with a one-line summary each; **CV2-5** stays as the remaining pending item. Leave the "Google Docs parity — features we don't have yet" list untouched.

- [ ] **Step 9: Format + final run**

```bash
npm run format
npm test && npm run typecheck && npm run build
```

- [ ] **Step 10: Commit + push**

```bash
git status   # src/worker.ts must NOT appear
git add CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/collab-chrome-v2.png package.json package-lock.json docs/TEST-COVERAGE.md ROADMAP.md tests/scripts/manual-testing/capture-collab-chrome-v2-screenshot.mjs tests/e2e/collab/mode-switcher.spec.ts
git commit -m "$(cat <<'EOF'
chore: release 1.X.0 — collab chrome v2 (Google Docs parity for view-only/suggesting)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin docs/collab-chrome-v2-spec
```

- [ ] **Step 11: Finalise PR #185**

Retitle to `feat(collab): view-only / suggesting chrome parity with Google Docs (v1.X.0)`, update the body to describe the implementation. Wait for CI green. Ready to merge on user confirmation.

---

## Self-review notes (addressed)

- **Spec coverage:** D-editmenu → Task 1 Step 4; D-comments → Task 1 Step 5 + Task 2; D-vh → Task 1 Step 5 + Task 3; D-share → Task 4; D-delete → Task 1 Step 5 (predicate `canDeleteDoc`); D-modedesc → Task 5; D-viewmenu (no `View ▸ Mode`) → nothing to build. CV2-5 explicitly out (spec Non-goal).
- **The `app.ts` empty-state move:** each of the 3 buttons has exactly one new owner (`#commentsBtn` → CommentsPanel, `#versionHistoryBtn` → VersionHistory, `#shareBtn`/`#shareDropdownBtn` → Share). Each owner combines `!$activeIdStore` with its mode/role term, so the empty-state behaviour is preserved. `app.ts` keeps the `#docTitle` / `#saveStatusBtn` / `#sidebarToggleIn` lines — those aren't touched.
- **`hidden` vs `disabled` on menu items:** v1.50.0 established the menus use the `hidden` attribute (not `{#if}`), so `bind:this` stays live and `MenuBar`'s `onMount` `pairs` array is safe. Task 1 keeps `hidden` for the Edit *items* and Format/Insert menus; only the File-menu *items* use `disabled` (they always did).
- **Type consistency:** `editingMode`, `viewing`, `nonEditorCollaborator`, `canDeleteDoc` — same definitions in `MenuBar` (Task 1), and the narrower per-component copies (`editingMode` in VersionHistory Task 3, the inline `nonEditor` in Share Task 4) match. `$effectiveMode` is `Mode | null`; `editingMode` treats `null` (local doc) as editing everywhere.
- **Placeholder scan:** no "TBD"/"handle edge cases". Task 3 Step 1 names a concrete fallback if the `VersionHistory.svelte` mount is too heavy. Task 4 Step 3's `shareAccessSummary()` says exactly which existing string to reuse/extract.
- **Components project:** all new component tests mount small components (MenuBar, CommentsPanel, ModeSwitcher, Share) that already have `components`-project tests — no `Editor.svelte` mount.
