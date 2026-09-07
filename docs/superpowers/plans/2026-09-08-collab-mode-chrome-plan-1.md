# Collaboration mode chrome — Plan 1: mode model, switcher & mode-driven chrome

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the reactive collab-mode model (`collabRole` ceiling + `chosenMode` + derived `effectiveMode`), the `ModeSwitcher.svelte` control, `bindActiveDoc` keyed off `effectiveMode`, and the Viewing-mode chrome changes A3 (hide Edit/Format/Insert), A4 (hide comments), C1 (floating sidebar button).

**Architecture:** A new `stores/collabMode.ts` holds the role and the user's chosen mode (per-`remoteId`, localStorage). `collab.ts` publishes the role on join and re-applies the editor's collab extensions whenever the derived `effectiveMode` changes. Components (`ModeSwitcher`, `MenuBar`, `CommentsPanel`) react to `$effectiveMode`; a `body.collab-viewing` class drives the C1 button via CSS.

**Tech Stack:** TypeScript, Svelte 5, CodeMirror 6 compartments, Vitest (`unit` + `components`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-collaboration-mode-chrome-design.md`

## Global Constraints

- No version bump / `CHANGELOG` version section / `whats-new` entry in this plan — those land in **Plan 3** (last of the three) as the shared `1.50.0` release. A provisional `## [1.50.0] - UNRELEASED` `CHANGELOG` heading may be added (Task 8).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. Never a `Claude-Session:` link. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Never `git add src/worker.ts` blindly — this plan does not touch it; keep it out of every `git add`.
- Two `tsconfig`s checked separately (`npm run typecheck`). Component test files go under `tests/client/src/components/*.test.ts` **only**.
- `collab.test.ts` is `// @vitest-environment jsdom` + `import "fake-indexeddb/auto"`, uses `MockWebSocket` + `vi.stubGlobal("fetch")` per `describe`, and `handleDocChanged(undefined)` in `beforeEach` to reset the `workspaceRoom` singleton.
- `Mode` = `"editing" | "suggesting" | "viewing"`. `Role` = `"viewer" | "reviewer" | "editor"`. Role→mode ceiling: `editor`→all three; `reviewer`→`suggesting`,`viewing`; `viewer`→`viewing`.
- `effectiveMode` is `null` when not in a shared workspace — nothing in this plan changes local (non-shared) editing.

---

## File Structure

- `client/src/stores/collabMode.ts` (create) — the store module. Sole owner of role/mode reactive state + localStorage.
- `client/src/collab.ts` (modify) — call `enterCollabRoom` / `leaveCollabRoom`; new `applyEditorMode`; `bindActiveDoc` uses it; `effectiveMode` subscription in `init()`.
- `client/src/components/ModeSwitcher.svelte` (create) — the topbar dropdown.
- `client/src/main.ts` (modify) — mount `ModeSwitcher`.
- `client/index.html` (modify) — `#mode-switcher-mount` in the topbar actions; `#viewingSidebarBtn`.
- `client/src/components/MenuBar.svelte` (modify) — `hidden` the Edit / Format / Insert menus + `#menuComments` when `$effectiveMode === "viewing"`.
- `client/src/components/CommentsPanel.svelte` (modify) — hide `#commentsBtn` + force `commentsPanelOpen` false in Viewing.
- `client/src/app.ts` (modify) — wire `#viewingSidebarBtn` to `toggleSidebar`.
- `client/src/styles/_topbar.scss` / `_editor-preview.scss` (modify) — `ModeSwitcher` + `#viewingSidebarBtn` styles.
- Tests: `tests/client/src/stores/collabMode.test.ts` (create), `tests/client/src/collab.test.ts` (modify), `tests/client/src/components/ModeSwitcher.test.ts` (create), `tests/client/src/components/MenuBar.test.ts` (modify), `tests/e2e/collab/mode-switcher.spec.ts` (create).

---

## Task 1: `stores/collabMode.ts`

**Files:**
- Create: `client/src/stores/collabMode.ts`
- Test: `tests/client/src/stores/collabMode.test.ts`

**Interfaces:**
- Produces: `collabRole: Writable<Role | null>`, `collabIsOwner: Writable<boolean>`, `collabRemoteId: Writable<string | null>`, `chosenMode: Writable<Mode | null>`, `effectiveMode: Readable<Mode | null>`, `modesAllowed: Readable<Mode[]>`, `setChosenMode(m: Mode): void`, `enterCollabRoom(remoteId: string, role: Role, isOwner: boolean): void`, `leaveCollabRoom(): void`. Types `Role`, `Mode` exported.

- [ ] **Step 1: Write the failing test**

Create `tests/client/src/stores/collabMode.test.ts`:

```ts
// @vitest-environment jsdom
import { test, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  collabRole,
  collabIsOwner,
  chosenMode,
  effectiveMode,
  modesAllowed,
  setChosenMode,
  enterCollabRoom,
  leaveCollabRoom,
} from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  localStorage.clear();
  leaveCollabRoom();
});

test("effectiveMode is null when not in a shared workspace", () => {
  expect(get(effectiveMode)).toBeNull();
});

test("effectiveMode defaults per role and clamps to the ceiling", () => {
  enterCollabRoom("r1", "viewer", false);
  expect(get(effectiveMode)).toBe("viewing");
  expect(get(modesAllowed)).toEqual(["viewing"]);

  enterCollabRoom("r2", "reviewer", false);
  expect(get(effectiveMode)).toBe("suggesting");

  enterCollabRoom("r3", "editor", true);
  expect(get(effectiveMode)).toBe("editing");
});

test("setChosenMode honours a valid pick and rejects one above the ceiling", () => {
  enterCollabRoom("r1", "reviewer", false);
  setChosenMode("editing"); // above ceiling — ignored
  expect(get(effectiveMode)).toBe("suggesting");
  setChosenMode("viewing");
  expect(get(effectiveMode)).toBe("viewing");
});

test("a chosen mode persists per remoteId and reloads on re-enter", () => {
  enterCollabRoom("r1", "editor", true);
  setChosenMode("viewing");
  leaveCollabRoom();
  enterCollabRoom("r1", "editor", true);
  expect(get(chosenMode)).toBe("viewing");
  expect(get(effectiveMode)).toBe("viewing");
});

test("a stored mode that now exceeds the role is clamped, not applied", () => {
  localStorage.setItem("mde:collabMode", JSON.stringify({ r1: "editing" }));
  enterCollabRoom("r1", "viewer", false);
  expect(get(effectiveMode)).toBe("viewing");
});

test("leaveCollabRoom resets everything", () => {
  enterCollabRoom("r1", "editor", true);
  setChosenMode("suggesting");
  leaveCollabRoom();
  expect(get(collabRole)).toBeNull();
  expect(get(collabIsOwner)).toBe(false);
  expect(get(chosenMode)).toBeNull();
  expect(get(effectiveMode)).toBeNull();
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run tests/client/src/stores/collabMode.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `client/src/stores/collabMode.ts`**

```ts
import { writable, derived, get, type Readable } from "svelte/store";

export type Role = "viewer" | "reviewer" | "editor";
export type Mode = "editing" | "suggesting" | "viewing";

const ALLOWED: Record<Role, Mode[]> = {
  editor: ["editing", "suggesting", "viewing"],
  reviewer: ["suggesting", "viewing"],
  viewer: ["viewing"],
};

const STORAGE_KEY = "mde:collabMode";

function loadChosen(remoteId: string | null): Mode | null {
  if (!remoteId) return null;
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Mode>)[remoteId] ?? null;
  } catch {
    return null;
  }
}

// null ⇒ not in a shared workspace (a plain local document). No mode
// chrome; editing behaves exactly as before.
export const collabRole = writable<Role | null>(null);
// True when this session's user owns the current shared workspace.
export const collabIsOwner = writable(false);
// The remoteId the chosen-mode preference is keyed to.
export const collabRemoteId = writable<string | null>(null);
// The user's explicit pick for the current room, or null = "role default".
export const chosenMode = writable<Mode | null>(null);

export function setChosenMode(mode: Mode): void {
  const remoteId = get(collabRemoteId);
  const role = get(collabRole);
  if (!remoteId || !role || !ALLOWED[role].includes(mode)) return;
  chosenMode.set(mode);
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Mode>;
    all[remoteId] = mode;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — in-memory store still drives this session */
  }
}

export function enterCollabRoom(remoteId: string, role: Role, isOwner: boolean): void {
  collabRemoteId.set(remoteId);
  collabRole.set(role);
  collabIsOwner.set(isOwner);
  chosenMode.set(loadChosen(remoteId));
}

export function leaveCollabRoom(): void {
  collabRemoteId.set(null);
  collabRole.set(null);
  collabIsOwner.set(false);
  chosenMode.set(null);
}

export const effectiveMode: Readable<Mode | null> = derived([collabRole, chosenMode], ([role, chosen]) => {
  if (!role) return null;
  const allowed = ALLOWED[role];
  return chosen && allowed.includes(chosen) ? chosen : allowed[0];
});

export const modesAllowed: Readable<Mode[]> = derived(collabRole, (role) => (role ? ALLOWED[role] : []));
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run tests/client/src/stores/collabMode.test.ts` — PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add client/src/stores/collabMode.ts tests/client/src/stores/collabMode.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): reactive collab-mode store (role ceiling + chosen mode)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `collab.ts` — publish/clear the role on join & teardown

**Files:**
- Modify: `client/src/collab.ts` — imports; `joinWorkspace` signature + body (~line 520); `teardownWorkspace` (~line 1000); `joinSharedLink` (~277), `rejoinKnownWorkspace` (~426), `seedWorkspaceForFirstShare` (~665) call sites.
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `enterCollabRoom`, `leaveCollabRoom` from `./stores/collabMode`.
- Produces: `joinWorkspace(id, { role, seedDocId?, isOwner? })` — `isOwner` defaults `false`; calls `enterCollabRoom(id, role, isOwner)` right after `workspaceRoom.role = role`. `teardownWorkspace()` calls `leaveCollabRoom()`.

- [ ] **Step 1: Write the failing tests**

In `tests/client/src/collab.test.ts`, add a `describe` (model on "owner-deleted-the-workspace teardown" — `MockWebSocket` + fetch stub returning an `access` with `owner: "alice"`, `window.MDE.githubUsername = "alice"`):

```ts
import { collabRole, collabIsOwner, effectiveMode } from "../../../client/src/stores/collabMode";

describe("collab-mode role publishing", () => {
  // ...setup connecting as the OWNER (githubUsername "alice", access.owner "alice")...
  it("publishes the role and ownership on join, clears on teardown", async () => {
    const { } = await setup("cm1"); // connects, editor role, owner
    expect(get(collabRole)).toBe("editor");
    expect(get(collabIsOwner)).toBe(true);
    expect(get(effectiveMode)).toBe("editing");

    teardownWorkspace();
    expect(get(collabRole)).toBeNull();
    expect(get(collabIsOwner)).toBe(false);
  });

  it("marks a non-owner collaborator isOwner=false", async () => {
    // access.owner "alice", githubUsername "bob"
    await setup("cm2", { username: "bob" });
    expect(get(collabRole)).toBe("editor"); // anyone-link editor
    expect(get(collabIsOwner)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/client/src/collab.test.ts -t "collab-mode role publishing"`
Expected: FAIL — `collabRole` stays `null`.

- [ ] **Step 3: Import + thread `isOwner`**

`client/src/collab.ts` imports (near the `./stores/workspaces` import):

```ts
import { enterCollabRoom, leaveCollabRoom } from "./stores/collabMode";
```

`joinWorkspace` signature + head:

```ts
async function joinWorkspace(
  workspaceId: string,
  { role, seedDocId, isOwner = false }: { role: string; seedDocId?: string; isOwner?: boolean },
): Promise<number> {
  teardownWorkspace();
  const myGeneration = joinGeneration;
  workspaceRoom.workspaceId = workspaceId;
  workspaceRoom.role = role;
  enterCollabRoom(workspaceId, role as "viewer" | "reviewer" | "editor", isOwner);
  // ...unchanged...
```

Call sites:
- `joinSharedLink` (localMatch branch, ~line 277): `await joinWorkspace(workspaceId, { role, isOwner: !!username && access.owner === username });`
- `rejoinKnownWorkspace` (~line 426): `const joined = await joinWorkspace(remoteId, { role, isOwner: !!window.MDE.githubUsername && access.owner === window.MDE.githubUsername });`
- `seedWorkspaceForFirstShare` (~line 665): `await joinWorkspace(activeDoc.workspaceId, { role: "editor", seedDocId: activeDoc.id, isOwner: true });`

`teardownWorkspace()` (~line 1000, at the end where it nulls `workspaceRoom.*`):

```ts
  workspaceRoom.reconnectDelay = 1000;
  leaveCollabRoom();
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run tests/client/src/collab.test.ts` — PASS (new + existing).

- [ ] **Step 5: Typecheck + commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): publish the collab role + ownership to the mode store on join

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `applyEditorMode` — mode drives the editor, live

**Files:**
- Modify: `client/src/collab.ts` — new `applyEditorMode`; `bindActiveDoc`'s role branch (~line 920-942); `init()` subscription (~line 246, after `onGithubAuthComplete`).
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `effectiveMode` from `./stores/collabMode`; `window.MDE.enterCollabMode`, `window.MDE.setReadOnly`, `lockToPreviewOnly`, `unlockViewMode`.
- Produces: `applyEditorMode(binding: DocBinding, mode: Mode): void` — rebuilds the collab extension set (yCollab always; `suggestionExtensions` for `editing`/`suggesting`, with `viewerRole` `"reviewer"` for suggesting else `"editor"`), calls `enterCollabMode` + `setReadOnly(mode === "viewing")` + lock/unlock. Toggles `document.body.classList` `collab-viewing`.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/collab.test.ts`, extend the "collab-mode role publishing" describe. Stub `window.MDE.enterCollabMode` / `setReadOnly` as `vi.fn()` in the setup, then:

```ts
it("re-applies the editor mode when effectiveMode changes mid-session", async () => {
  await setup("cm3"); // editor, owner, one doc, bound
  const enterSpy = window.MDE.enterCollabMode as unknown as ReturnType<typeof vi.fn>;
  const roSpy = window.MDE.setReadOnly as unknown as ReturnType<typeof vi.fn>;
  enterSpy.mockClear();
  roSpy.mockClear();

  setChosenMode("viewing");
  for (let i = 0; i < 5; i++) await Promise.resolve();

  expect(roSpy).toHaveBeenCalledWith(true);
  expect(document.body.classList.contains("collab-viewing")).toBe(true);

  setChosenMode("editing");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(roSpy).toHaveBeenLastCalledWith(false);
  expect(document.body.classList.contains("collab-viewing")).toBe(false);
});
```

(Import `setChosenMode` from `collabMode`.)

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/client/src/collab.test.ts -t "re-applies the editor mode"`
Expected: FAIL.

- [ ] **Step 3: Add `applyEditorMode`, use it in `bindActiveDoc`, subscribe in `init()`**

`client/src/collab.ts` imports:

```ts
import { enterCollabRoom, leaveCollabRoom, effectiveMode, type Mode } from "./stores/collabMode";
```

New function (place next to `bindActiveDoc`):

```ts
// Applies a collab Mode to the editor surface. Called from bindActiveDoc
// on every doc bind, and from init()'s effectiveMode subscription when the
// user switches mode mid-session. Rebuilds the editingMode compartment
// (via enterCollabMode) rather than adding a dedicated bridge method —
// enterCollabMode already reconfigures exactly that compartment.
function applyEditorMode(binding: DocBinding, mode: Mode): void {
  const viewing = mode === "viewing";
  const undoManager = binding.undoManager || new Y.UndoManager(binding.ytext);
  binding.undoManager = undoManager;
  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  const extensions = [yCollab(binding.ytext, binding.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)];
  if (!viewing) {
    const viewerRole = mode === "suggesting" ? "reviewer" : "editor";
    extensions.push(...suggestionExtensions(binding.ydoc, identity.name, { viewerRole, viewerName: identity.name }));
  }
  window.MDE.enterCollabMode(extensions, undoManager);
  window.MDE.setReadOnly(viewing);
  if (viewing) lockToPreviewOnly();
  else unlockViewMode();
  document.body.classList.toggle("collab-viewing", viewing);
}
```

In `bindActiveDoc`, replace the block from `const undoManager = binding.undoManager || new Y.UndoManager(...)` through the `if (binding.role === "viewer") { lockToPreviewOnly(); } else { unlockViewMode(); }` (~lines 916-942) with:

```ts
  applyEditorMode(binding, get(effectiveMode) ?? "editing");
```

Keep everything after (the `binding.awareness.setLocalState({ ..., role: binding.role, ... })` line and below — presence still shows the true role, not the self-selected mode).

In `init()`, after the `window.MDE.onGithubAuthComplete = ...` line:

```ts
  // Live mode switching: when the user picks a different mode in
  // ModeSwitcher, re-apply it to whatever doc is currently bound. Fires
  // immediately with the current value too (a no-op while activeDocId is
  // null, i.e. before any bind or outside a shared workspace).
  effectiveMode.subscribe((mode) => {
    if (!mode || !workspaceRoom.activeDocId) return;
    const binding = workspaceRoom.docs.get(workspaceRoom.activeDocId);
    if (binding) applyEditorMode(binding, mode);
  });
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run tests/client/src/collab.test.ts` — PASS.
Watch the existing "suggestion-mode role wiring" and "readonly-and-editing-mode" coverage especially — `applyEditorMode` must reproduce the old per-role behaviour for the default mode of each role (editor→editing, reviewer→suggesting, viewer→viewing).

- [ ] **Step 5: Typecheck + full client suite**

Run: `npm run typecheck` — clean.
Run: `npm test` — all green.

- [ ] **Step 6: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): drive the editor surface from effectiveMode, live

bindActiveDoc applies the effective mode (role default, or the user's
ModeSwitcher pick) instead of hard-branching on binding.role; an
init()-level effectiveMode subscription re-applies it on a mid-session
switch. Adds the body.collab-viewing class.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ModeSwitcher.svelte`

**Files:**
- Create: `client/src/components/ModeSwitcher.svelte`
- Modify: `client/index.html` (add `<div id="mode-switcher-mount"></div>` inside `#topbarActionsCol .topbar-actions`, before `#shareBtnGroup`), `client/src/main.ts` (mount it), `client/src/styles/_topbar.scss` (styles).
- Test: `tests/client/src/components/ModeSwitcher.test.ts`

**Interfaces:**
- Consumes: `effectiveMode`, `modesAllowed`, `collabRole`, `setChosenMode` from `../stores/collabMode`; `window.MDE.closeAllDropdowns`.
- Renders nothing when `$collabRole === null`.

- [ ] **Step 1: Write the failing component test**

Create `tests/client/src/components/ModeSwitcher.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ModeSwitcher from "../../../../client/src/components/ModeSwitcher.svelte";
import { collabRole, chosenMode, enterCollabRoom, leaveCollabRoom, effectiveMode } from "../../../../client/src/stores/collabMode";
import { get } from "svelte/store";

beforeEach(() => {
  localStorage.clear();
  leaveCollabRoom();
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
});

test("renders nothing outside a shared workspace", async () => {
  const screen = render(ModeSwitcher);
  await expect.poll(() => screen.container.textContent?.trim()).toBe("");
});

test("an editor sees all three modes and picking one applies it", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = render(ModeSwitcher);
  await screen.getByRole("button", { name: /Editing/i }).click();
  await screen.getByRole("menuitem", { name: /Viewing/i }).click();
  expect(get(effectiveMode)).toBe("viewing");
});

test("a reviewer sees only Suggesting + Viewing", async () => {
  enterCollabRoom("r2", "reviewer", false);
  const screen = render(ModeSwitcher);
  await screen.getByRole("button").click();
  await expect.poll(() => screen.getByRole("menuitem", { name: /Editing/i }).all().then((a) => a.length)).toBe(0);
  expect((await screen.getByRole("menuitem").all()).length).toBe(2);
});

test("a viewer's switcher shows Viewing with no open menu", async () => {
  enterCollabRoom("r3", "viewer", false);
  const screen = render(ModeSwitcher);
  await expect.element(screen.getByRole("button", { name: /Viewing/i })).toBeVisible();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `client/src/components/ModeSwitcher.svelte`**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { effectiveMode, modesAllowed, collabRole, setChosenMode, type Mode } from "../stores/collabMode";

  let open = $state(false);

  const LABELS: Record<Mode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  const ICONS: Record<Mode, string> = { editing: "icon-pencil", suggesting: "icon-message-square", viewing: "icon-eye" };

  function pick(m: Mode) {
    setChosenMode(m);
    open = false;
  }
  function toggle() {
    if ($modesAllowed.length < 2) return; // a viewer has nothing to choose
    window.MDE.closeAllDropdowns?.();
    open = !open;
  }

  onMount(() => {
    const onDoc = (e: MouseEvent) => {
      if (open && !(e.target as HTMLElement).closest(".mode-switcher")) open = false;
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  });
</script>

{#if $collabRole && $effectiveMode}
  <div class="mode-switcher dropdown">
    <button type="button" class="mode-switcher-btn" onclick={toggle} aria-haspopup="menu" aria-expanded={open}>
      <svg class="icon"><use href="#{ICONS[$effectiveMode]}"></use></svg>
      <span class="mode-switcher-label">{LABELS[$effectiveMode]}</span>
      {#if $modesAllowed.length > 1}<svg class="icon menu-chevron"><use href="#icon-chevron-down"></use></svg>{/if}
    </button>
    {#if open}
      <div class="dropdown-menu mode-switcher-menu" role="menu">
        {#each $modesAllowed as m (m)}
          <button type="button" role="menuitem" class="dropdown-item" class:active={m === $effectiveMode} onclick={() => pick(m)}>
            <svg class="icon"><use href="#{ICONS[m]}"></use></svg> {LABELS[m]}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
```

If `#icon-eye` is not already a `<symbol>` in `client/index.html`, add one (a simple eye path — reuse the one from `Settings.svelte`'s Viewing option if present, else a standard 24×24 eye).

- [ ] **Step 4: Mount + markup + styles**

`client/index.html`, inside `<div class="topbar-actions">` immediately before `<div class="share-btn-group" id="shareBtnGroup">`:

```html
            <div id="mode-switcher-mount"></div>
```

`client/src/main.ts`, next to the other topbar mounts (after `MenuBar`):

```ts
import ModeSwitcher from "./components/ModeSwitcher.svelte";
// ...
mount(ModeSwitcher, { target: document.getElementById("mode-switcher-mount")! });
```

`client/src/styles/_topbar.scss` — a compact pill matching `.icon-btn` / `.share-pill` neighbours: `.mode-switcher-btn` inline-flex, gap 6px, the existing `.dropdown-menu` handles the popover. Hide `.mode-switcher-label` under `@media (max-width: 780px)` (icon-only on mobile). Keep it visually consistent with `#versionHistoryBtn` / `#commentsBtn`.

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts` — PASS.
Run: `npm run typecheck` — clean.
Run: `npm run build` — succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ModeSwitcher.svelte client/src/main.ts client/index.html client/src/styles/_topbar.scss tests/client/src/components/ModeSwitcher.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): ModeSwitcher — Editing / Suggesting / Viewing, bounded by role

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: A3 — hide Edit / Format / Insert in Viewing

**Files:**
- Modify: `client/src/components/MenuBar.svelte`
- Test: `tests/client/src/components/MenuBar.test.ts`

**Interfaces:**
- Consumes: `effectiveMode` from `../stores/collabMode`.
- Behaviour: the `Edit`, `Format`, `Insert` top-level menu wrappers and `#menuComments` get `hidden={$effectiveMode === "viewing"}`. **`hidden` attribute, not `{#if}`** — the `bind:this` refs (`editMenuBtn` etc.) and `onMount`'s dropdown wiring must stay intact; a `hidden` button is unfocusable and unclickable, which is all A3 needs.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/MenuBar.test.ts` (extend the existing file — it already renders `MenuBar` with a `window.MDE` proxy):

```ts
import { effectiveMode, enterCollabRoom, leaveCollabRoom } from "../../../../client/src/stores/collabMode";

// in a new test:
test("A3: Edit / Format / Insert menus are hidden in Viewing mode", async () => {
  leaveCollabRoom();
  const screen = render(MenuBar);
  expect(screen.container.querySelector("#editMenuBtn")?.hasAttribute("hidden")).toBe(false);

  enterCollabRoom("r1", "viewer", false); // effectiveMode → "viewing"
  await expect.poll(() => screen.container.querySelector("#editMenuBtn")?.hasAttribute("hidden")).toBe(true);
  expect(screen.container.querySelector("#formatMenuBtn")?.hasAttribute("hidden")).toBe(true);
  expect(screen.container.querySelector("#insertMenuBtn")?.hasAttribute("hidden")).toBe(true);
  // File / View / Help stay
  expect(screen.container.querySelector("#fileMenuBtn")?.hasAttribute("hidden")).toBe(false);
  expect(screen.container.querySelector("#viewMenuBtn")?.hasAttribute("hidden")).toBe(false);

  enterCollabRoom("r2", "editor", true);
  await expect.poll(() => screen.container.querySelector("#editMenuBtn")?.hasAttribute("hidden")).toBe(false);
});
```

Add `leaveCollabRoom()` to the file's `beforeEach`.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts -t "A3"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client/src/components/MenuBar.svelte` script:

```ts
  import { effectiveMode } from "../stores/collabMode";
  const viewing = $derived($effectiveMode === "viewing");
```

On the three `<div class="dropdown">` wrappers for Edit / Format / Insert, add `hidden={viewing}`:

```svelte
  <div class="dropdown" hidden={viewing}>
    <button bind:this={editMenuBtn} id="editMenuBtn" ...>Edit</button>
    ...
```

On `#menuComments`:

```svelte
      <button id="menuComments" type="button" hidden={viewing} disabled={!hasActiveDoc} onclick={...}>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project=components tests/client/src/components/MenuBar.test.ts` — PASS (new + existing).
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/MenuBar.svelte tests/client/src/components/MenuBar.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): hide Edit / Format / Insert menus in Viewing mode (A3)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: A4 — no comments button/panel in Viewing

**Files:**
- Modify: `client/src/components/CommentsPanel.svelte`
- Test: `tests/client/src/components/CommentsPanel.test.ts` (extend, or create if absent)

**Interfaces:**
- Consumes: `effectiveMode` from `../stores/collabMode`.
- Behaviour: while `$effectiveMode === "viewing"`, `#commentsBtn` gets `hidden`, and `commentsPanelOpen` is forced `false`. Inline editor comment highlights need no separate handling — Viewing locks to preview-only, so there is no editor surface showing them.

- [ ] **Step 1: Write the failing test**

`tests/client/src/components/CommentsPanel.test.ts` (extend / create):

```ts
import { effectiveMode, enterCollabRoom, leaveCollabRoom } from "../../../../client/src/stores/collabMode";
import { commentsPanelOpen } from "../../../../client/src/stores/commentsPanel";
import { get } from "svelte/store";

test("A4: the comments button is hidden and the panel forced closed in Viewing", async () => {
  // #commentsBtn lives in index.html — the test harness must provide it:
  document.body.querySelector("#commentsBtn")?.remove();
  const btn = document.createElement("button");
  btn.id = "commentsBtn";
  document.body.appendChild(btn);

  leaveCollabRoom();
  commentsPanelOpen.set(true);
  render(CommentsPanel);

  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => btn.hasAttribute("hidden")).toBe(true);
  await expect.poll(() => get(commentsPanelOpen)).toBe(false);

  enterCollabRoom("r2", "editor", true);
  await expect.poll(() => btn.hasAttribute("hidden")).toBe(false);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/CommentsPanel.test.ts -t "A4"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client/src/components/CommentsPanel.svelte` script — add next to the existing `#commentsBtn` class-toggle `$effect` (~line 174):

```ts
  import { effectiveMode } from "../stores/collabMode";

  $effect(() => {
    const viewing = $effectiveMode === "viewing";
    document.getElementById("commentsBtn")?.toggleAttribute("hidden", viewing);
    if (viewing) commentsPanelOpen.set(false);
  });
```

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `npx vitest run --project=components tests/client/src/components/CommentsPanel.test.ts` — PASS.
Run: `npm run typecheck` — clean.

```bash
git add client/src/components/CommentsPanel.svelte tests/client/src/components/CommentsPanel.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): hide comments button + panel in Viewing mode (A4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: C1 — floating sidebar button in Viewing

**Files:**
- Modify: `client/index.html` (add `#viewingSidebarBtn`), `client/src/app.ts` (wire the click), `client/src/styles/_editor-preview.scss` (styles + `:has()` visibility rule).
- Test: `tests/e2e/collab/mode-switcher.spec.ts` (created in Task 8 covers it; add the assertion there).

**Interfaces:**
- Consumes: `window.MDE.toggleSidebar` (already on the bridge).
- Behaviour: a fixed circular button, shown only when `body.collab-viewing` **and** `#sidebar.collapsed`, click → `toggleSidebar()`.

- [ ] **Step 1: Add the markup**

`client/index.html`, next to `#focusModeExitBtn`:

```html
    <!-- Shown only in Viewing mode while the documents sidebar is
     collapsed — Viewing hides the toolbar (its #sidebarToggleOut) and a
     collapsed sidebar then has no re-open control. See _editor-preview.scss. -->
    <button id="viewingSidebarBtn" class="viewing-sidebar-btn" type="button" aria-label="Show documents">
      <svg class="icon"><use href="#icon-menu"></use></svg>
    </button>
```

- [ ] **Step 2: Style it**

`client/src/styles/_editor-preview.scss`:

```scss
.viewing-sidebar-btn {
  display: none;
}
body.collab-viewing:has(#sidebar.collapsed) .viewing-sidebar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  position: fixed;
  bottom: 16px;
  left: 16px;
  z-index: 50;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg);
  box-shadow: var(--shadow);
  color: var(--text);
}
```

- [ ] **Step 3: Wire the click**

`client/src/app.ts`, in `initSidebar()` next to the other toggle wiring:

```ts
    document.getElementById("viewingSidebarBtn")?.addEventListener("click", () => toggleSidebar());
```

- [ ] **Step 4: Manual check + build**

Run: `npm run build` — succeeds.
Manual (browser): join a shared workspace as a viewer, collapse the sidebar → the button appears bottom-left; click → sidebar opens, button hides. Switch to Editing → button gone regardless.

- [ ] **Step 5: Commit**

```bash
git add client/index.html client/src/app.ts client/src/styles/_editor-preview.scss
git commit -m "$(cat <<'EOF'
feat(collab): floating sidebar-open button in Viewing mode (C1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full verification + E2E + provisional CHANGELOG

**Files:**
- Create: `tests/e2e/collab/mode-switcher.spec.ts`
- Modify: `CHANGELOG.md` (provisional heading only), `docs/TEST-COVERAGE.md`

- [ ] **Step 1: Write the E2E spec**

Create `tests/e2e/collab/mode-switcher.spec.ts`, modelled on `live-collab.spec.ts` (`ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`):

```ts
import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace } from "./support/collab";

test("a collaborator switches Editing → Viewing and the chrome follows", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "mode-owner-e2e", "the shared body");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expect.poll(() => b.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("the shared body");

  // Editing → Format menu present, editor pane present.
  await expect(b.locator("#formatMenuBtn")).toBeVisible();
  await expect(b.locator("#editorPane")).toBeVisible();

  // Switch to Viewing.
  await b.click(".mode-switcher-btn");
  await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Viewing")');

  await expect(b.locator("#formatMenuBtn")).toBeHidden();
  await expect(b.locator("#commentsBtn")).toBeHidden();
  await expect(b.locator("#body.mode-preview")).toBeVisible(); // editor pane gone

  // Collapse the sidebar → floating button appears.
  await b.click("#sidebarToggleIn").catch(() => {});
  await expect(b.locator("#viewingSidebarBtn")).toBeVisible();

  // Back to Editing.
  await b.click(".mode-switcher-btn");
  await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Editing")');
  await expect(b.locator("#formatMenuBtn")).toBeVisible();
  await expect(b.locator("#viewingSidebarBtn")).toBeHidden();

  await aCtx.close();
  await bCtx.close();
});

test("a viewer-role link only offers Viewing", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();
  await ownerWithDoc(a, "mode-viewer-e2e", "body");
  const url = await shareAnyoneLink(a, "Viewer");
  await joinSharedWorkspace(b, url);
  await expect(b.locator(".mode-switcher-btn")).toContainText("Viewing");
  await b.click(".mode-switcher-btn");
  await expect(b.locator(".mode-switcher-menu")).toHaveCount(0); // inert for a single option
  await aCtx.close();
  await bCtx.close();
});
```

- [ ] **Step 2: Run everything**

```bash
npm test
npm run typecheck
npm run format:check      # run `npm run format` if it flags anything, then re-add
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```

All green. If the sandbox Playwright browser is stale, apply the `playwright.config.ts` `executablePath` workaround from `CLAUDE.md`, run, then revert before committing.

- [ ] **Step 3: Provisional CHANGELOG heading**

`CHANGELOG.md` — add above the current top section (only if not already present from a sibling plan):

```markdown
## [1.50.0] - UNRELEASED

### Added

- **Editing / Suggesting / Viewing mode switcher.** In a shared workspace, a switcher next to Share lets you work below your granted role — an editor can review as a suggester or read as a viewer. Viewing mode hides the editing menus, the comments panel, and the editor pane. (More in this release — see `docs/superpowers/plans/`.)
```

- [ ] **Step 4: `docs/TEST-COVERAGE.md`**

Add rows under §10 (Workspace collab): `collabMode` store (ceiling/clamp/persist), `collab.ts` role publishing + live `applyEditorMode`, `ModeSwitcher` role-bounded options, MenuBar A3, CommentsPanel A4, the `mode-switcher` e2e. Follow the table format; cite the spec.

- [ ] **Step 5: Commit + push + PR**

```bash
git add tests/e2e/collab/mode-switcher.spec.ts CHANGELOG.md docs/TEST-COVERAGE.md
git commit -m "$(cat <<'EOF'
test: mode-switcher e2e + coverage rows; provisional 1.50.0 CHANGELOG

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin feat/collab-mode-chrome
```

Open a PR against `master`, title `feat(collab): Editing/Suggesting/Viewing mode switcher + Viewing chrome (plan 1/3)`. Body: the mode model, the switcher, the `effectiveMode`-driven editor + A3/A4/C1. Note this is plan 1 of 3 toward one `1.50.0` release; **do not merge yet** unless told — plans accumulate on this branch (workspace-pivot pattern). Report status and ask.

---

## Self-review notes (addressed)

- **Spec coverage:** mode model → T1; role publish → T2; `effectiveMode`-driven editor + live switch → T3; switcher → T4; A3 → T5; A4 → T6; C1 → T7. A1/A2/A5 are Plan 2; B1/B2 are Plan 3 (per the spec's split).
- **`hidden` vs `{#if}` for the menus:** the spec flagged the `bind:this` hazard; this plan resolves it by using the `hidden` attribute (T5 Step 3) so the refs and `onMount` wiring stay live.
- **`applyEditorMode` reuses `enterCollabMode`** rather than adding the `reconfigureCollabMode` bridge method the spec sketched — `enterCollabMode` already reconfigures exactly the `editingModeCompartment`. Simpler, no `types.ts` / `Editor.svelte` change.
- **Type consistency:** `Mode` / `Role` imported from `collabMode` everywhere. `joinWorkspace`'s `isOwner?: boolean` (default false) consumed identically at all three call sites (T2 Step 3).
- **Presence still shows the true `binding.role`** — `applyEditorMode` does not touch `binding.awareness.setLocalState` (T3 Step 3 keeps that line in `bindActiveDoc`).
- **`#icon-eye`** — T4 Step 3 adds the `<symbol>` if missing.
- **Known follow-ups (not this plan):** consolidating `#suggestionsBtn` into the switcher (D-series); the `body.collab-viewing` class is currently only consumed by C1's CSS — Plan 2/3 may add more rules.
