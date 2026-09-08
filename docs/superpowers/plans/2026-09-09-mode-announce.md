# Transient mode announcement toast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a shared-workspace collaborator switches collab mode, or first enters a shared workspace this page-load, flash a toast — "You're now editing / suggesting / viewing".

**Architecture:** A pure decision function `nextAnnouncement(prev, next, seen)` in a new `client/src/mode-announce.ts`, plus a thin `initModeAnnounce()` that subscribes to the `effectiveMode` derived store and calls the existing `showToast`. `showToast` gains a `return id` (one line) so the module can dismiss its previous mode toast before showing the next. Wired into `collab.ts` at module load, next to the existing `effectiveMode.subscribe`.

**Tech Stack:** TypeScript, Svelte stores (`writable` / `derived` / `get`), Vitest (`unit` project — jsdom), Playwright (`collab` project — real Worker + two browsers).

**Spec:** `docs/superpowers/specs/2026-09-09-mode-announce-design.md`

## Global Constraints

- Two `tsconfig.json`s, checked separately. `mode-announce.ts` is under `client/src/` (governed by `client/tsconfig.json`, relaxed) — write it clean regardless.
- `npm run format` (Prettier) and `npm run typecheck` must pass before every commit.
- Exact toast copy — `editing` → `"You're now editing"`, `suggesting` → `"You're now suggesting"`, `viewing` → `"You're now viewing"`.
- User-facing → **minor** bump to `1.55.0`: `package.json` + **both** `"version"` fields in `package-lock.json` (hand-edit); a `## [1.55.0] - <today>` CHANGELOG section (`### Added`); one `client/src/whats-new-entries.ts` entry **with a real committed screenshot** at `client/public/whats-new/mode-announce.png` (`whats-new-entries.test.ts` fails if it's missing); `category` must be one of `"Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation"`.
- `docs/TEST-COVERAGE.md` gets a row.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/src/stores/toast.ts` | `showToast` returns its numeric id | 1 |
| `tests/client/src/stores/toast.test.ts` | assert the returned id round-trips through `dismissToast` | 1 |
| `client/src/mode-announce.ts` (new) | `MODE_ANNOUNCE_COPY`, the pure `nextAnnouncement`, and `initModeAnnounce()` | 2 |
| `tests/client/src/mode-announce.test.ts` (new) | drive `nextAnnouncement` through every trigger / non-trigger case | 2 |
| `client/src/collab.ts` | `import` + call `initModeAnnounce()` at module load | 2 |
| `tests/e2e/collab/mode-switcher.spec.ts` | assert the toast text appears on a mode switch | 2 |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/mode-announce.png`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | release | 3 |
| `tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs` (new) | one-off What's New screenshot capture | 3 |

---

## Task 1: `showToast` returns its id

**Files:**
- Modify: `client/src/stores/toast.ts` (the `showToast` function, ~line 22)
- Test: `tests/client/src/stores/toast.test.ts` (add one `it` to the existing `describe("regular toasts (SHELL-05)")`)

**Interfaces:**
- Consumes: nothing.
- Produces: `showToast(message: string, type?: ToastType, duration?: number): number` — returns the new toast's `id` (a positive integer). Existing callers ignore it. Task 2 uses it.

**Context an implementer needs:**
- Current `client/src/stores/toast.ts`:
  ```ts
  export function showToast(message: string, type: ToastType = "info", duration = 3200) {
    const id = nextId++;
    toasts.update((list) => [...list, { id, message, type }]);
    setTimeout(() => dismissToast(id), duration);
  }
  ```
- `nextId` starts at `1` and only increments, so every id is `>= 1`.
- The test file imports from `"../../../../client/src/stores/toast"` and uses `vi.useFakeTimers()` in `beforeEach` (already set up in that `describe`).

- [ ] **Step 1: Write the failing test**

In `tests/client/src/stores/toast.test.ts`, inside `describe("regular toasts (SHELL-05)", ...)`, add:

```ts
it("returns the new toast's id, which dismissToast accepts", () => {
  const id = showToast("hello");
  expect(typeof id).toBe("number");
  expect(id).toBeGreaterThan(0);
  expect(get(toasts).some((t) => t.id === id)).toBe(true);
  dismissToast(id);
  expect(get(toasts)).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/client/src/stores/toast.test.ts -t "returns the new toast's id"`
Expected: FAIL — `showToast` returns `undefined`, so `typeof id` is `"undefined"`.

- [ ] **Step 3: Add the return**

In `client/src/stores/toast.ts`, change the `showToast` signature + body:

```ts
export function showToast(message: string, type: ToastType = "info", duration = 3200): number {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type }]);
  setTimeout(() => dismissToast(id), duration);
  return id;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/stores/toast.test.ts`
Expected: PASS (the whole file — the new test plus all existing SHELL-05 / progress-toast tests, which ignore the return value).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add client/src/stores/toast.ts tests/client/src/stores/toast.test.ts
git commit -m "$(cat <<'EOF'
refactor(toast): showToast returns its id

Lets a caller keep a handle to the toast it just raised (dismiss it
later, replace it). No behaviour change for existing callers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: the mode-announcement module

**Files:**
- Create: `client/src/mode-announce.ts`
- Create: `tests/client/src/mode-announce.test.ts`
- Modify: `client/src/collab.ts` (one import + one call, near line 279)
- Modify: `tests/e2e/collab/mode-switcher.spec.ts` (add assertions to the first test)

**Interfaces:**
- Consumes:
  - `showToast(message: string, type?: ToastType): number` and `dismissToast(id: number): void` from `./stores/toast` (Task 1).
  - From `./stores/collabMode`: `collabRemoteId: Writable<string | null>`, `effectiveMode: Readable<Mode | null>`, `type Mode = "editing" | "suggesting" | "viewing"`.
  - `get` from `svelte/store`.
- Produces:
  - `MODE_ANNOUNCE_COPY: Record<Mode, string>`
  - `interface ModeState { remoteId: string | null; mode: Mode | null }`
  - `nextAnnouncement(prev: ModeState, next: ModeState, seen: Set<string>): Mode | null` — pure except it `seen.add(...)`s on a counted workspace entry.
  - `initModeAnnounce(): void` — subscribes; call exactly once.

**Context an implementer needs:**
- `client/src/stores/collabMode.ts` exports `collabRemoteId` (a `writable<string | null>`), `effectiveMode` (a `derived([collabRole, chosenMode], …)` → `Mode | null`), and `type Mode`.
- `effectiveMode` recomputes only when `collabRole` or `chosenMode` change. `enterCollabRoom(remoteId, role, isOwner)` sets `collabRemoteId` **first**, then `collabRole`, then `chosenMode` — so inside an `effectiveMode` subscriber, `get(collabRemoteId)` already reflects the new room. A plain document rebind never changes role/chosenMode, so the subscription does **not** fire on doc switches within a workspace.
- A Svelte store `.subscribe(fn)` calls `fn` once synchronously with the current value, then on every change. At module load `effectiveMode` is `null` (no workspace yet) — the immediate call is a no-op (`nextAnnouncement` returns `null` for `mode: null`).
- `collab.ts` already has, at ~line 279, a module-level `effectiveMode.subscribe((mode) => { … applyEditorMode … })`. Add the new wiring right after it. `collab.ts` imports from `"./stores/collabMode"` at line 70 and from `"./stores/toast"` — check whether a toast import already exists (`grep -n 'stores/toast' client/src/collab.ts`); reuse it or add `import`.
- The e2e `collab` project: `tests/e2e/collab/mode-switcher.spec.ts`, helpers `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace` from `./support/collab`. Toasts render as `.toast` elements with a `.toast-message` span inside `.toast-stack` (bottom-center). They auto-dismiss after 3200 ms — assert promptly after the click.

- [ ] **Step 1: Write the failing unit test**

Create `tests/client/src/mode-announce.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextAnnouncement, MODE_ANNOUNCE_COPY, type ModeState } from "../../../client/src/mode-announce";

const S = (remoteId: string | null, mode: ModeState["mode"]): ModeState => ({ remoteId, mode });

describe("nextAnnouncement", () => {
  it("says nothing for a plain local document (no mode, no workspace)", () => {
    expect(nextAnnouncement(S(null, null), S(null, null), new Set())).toBeNull();
  });

  it("announces the mode on first entry to a workspace and marks it seen", () => {
    const seen = new Set<string>();
    expect(nextAnnouncement(S(null, null), S("w1", "viewing"), seen)).toBe("viewing");
    expect(seen.has("w1")).toBe(true);
  });

  it("announces a real mode change within the same workspace", () => {
    expect(nextAnnouncement(S("w1", "viewing"), S("w1", "suggesting"), new Set(["w1"]))).toBe("suggesting");
  });

  it("says nothing when the mode is unchanged in a workspace already seen", () => {
    expect(nextAnnouncement(S("w1", "viewing"), S("w1", "viewing"), new Set(["w1"]))).toBeNull();
  });

  it("says nothing when re-entering a workspace already announced this session", () => {
    expect(nextAnnouncement(S(null, null), S("w1", "viewing"), new Set(["w1"]))).toBeNull();
  });

  it("says nothing when leaving a workspace", () => {
    expect(nextAnnouncement(S("w1", "viewing"), S(null, null), new Set(["w1"]))).toBeNull();
  });

  it("announces on switching to a different, unseen workspace and marks it seen", () => {
    const seen = new Set<string>(["w1"]);
    expect(nextAnnouncement(S("w1", "editing"), S("w2", "viewing"), seen)).toBe("viewing");
    expect(seen.has("w2")).toBe(true);
  });
});

describe("MODE_ANNOUNCE_COPY", () => {
  it("has the exact agreed string for each mode", () => {
    expect(MODE_ANNOUNCE_COPY).toEqual({
      editing: "You're now editing",
      suggesting: "You're now suggesting",
      viewing: "You're now viewing",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/client/src/mode-announce.test.ts`
Expected: FAIL — cannot resolve `../../../client/src/mode-announce`.

- [ ] **Step 3: Create the module**

Create `client/src/mode-announce.ts`:

```ts
import { get } from "svelte/store";
import { collabRemoteId, effectiveMode, type Mode } from "./stores/collabMode";
import { showToast, dismissToast } from "./stores/toast";

export const MODE_ANNOUNCE_COPY: Record<Mode, string> = {
  editing: "You're now editing",
  suggesting: "You're now suggesting",
  viewing: "You're now viewing",
};

export interface ModeState {
  remoteId: string | null;
  mode: Mode | null;
}

// Pure decision: given the previous state this ran with and the current
// state, return the Mode to announce, or null. Counts a workspace entry
// by adding its remoteId to `seen` (the one side effect).
export function nextAnnouncement(prev: ModeState, next: ModeState, seen: Set<string>): Mode | null {
  if (!next.mode || !next.remoteId) return null;
  if (next.remoteId === prev.remoteId) {
    return next.mode !== prev.mode ? next.mode : null;
  }
  if (seen.has(next.remoteId)) return null;
  seen.add(next.remoteId);
  return next.mode;
}

// Subscribe effectiveMode → toast. Call exactly once (from collab.ts at
// module load). effectiveMode fires its current value immediately
// (null at load — a no-op) and then on every role/chosenMode change;
// enterCollabRoom sets collabRemoteId before collabRole, so
// get(collabRemoteId) here already reflects the new room. A plain doc
// rebind does not fire this (it never touches role/chosenMode).
export function initModeAnnounce(): void {
  let prev: ModeState = { remoteId: null, mode: null };
  const seen = new Set<string>();
  let lastToastId: number | null = null;

  effectiveMode.subscribe((mode) => {
    const next: ModeState = { remoteId: get(collabRemoteId), mode };
    const toAnnounce = nextAnnouncement(prev, next, seen);
    prev = next;
    if (!toAnnounce) return;
    if (lastToastId !== null) dismissToast(lastToastId);
    lastToastId = showToast(MODE_ANNOUNCE_COPY[toAnnounce], "info");
  });
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/client/src/mode-announce.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire it into `collab.ts`**

Run `grep -n 'stores/toast' client/src/collab.ts` first.
- If there's already an import from `"./stores/toast"`, leave it.
- Add near the other imports (after line 70's `collabMode` import):
  ```ts
  import { initModeAnnounce } from "./mode-announce";
  ```
- Immediately **after** the existing `effectiveMode.subscribe((mode) => { … });` block (ends ~line 284), add:
  ```ts
  // Flash a toast when the collab mode changes, or on first entry to a
  // shared workspace this page-load. See mode-announce.ts.
  initModeAnnounce();
  ```

- [ ] **Step 6: Run the full unit suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. (`initModeAnnounce()` runs at import time under jsdom too; `effectiveMode` is `null` there so it only subscribes and no-ops. No existing test asserts on the toast store at collab-module load.)

- [ ] **Step 7: Add the e2e assertion**

In `tests/e2e/collab/mode-switcher.spec.ts`, in the first test (`"a collaborator switches Editing → Viewing and the chrome follows"`), right after the block that switches to Viewing (after `await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Viewing")');`), add:

```ts
  // A transient toast announces the new mode.
  await expect(b.locator(".toast", { hasText: "You're now viewing" })).toBeVisible();
```

And after the "Back to Editing" block (after `await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Editing")');`), add:

```ts
  await expect(b.locator(".toast", { hasText: "You're now editing" })).toBeVisible();
```

- [ ] **Step 8: Run the collab e2e**

Run: `npm run test:e2e:collab`
Expected: PASS — `mode-switcher.spec.ts` (all 3 tests) plus the rest of the suite. (This applies + reverts the dev-login patch itself.)

If the sandbox lacks the Playwright browser, see `CLAUDE.md` → "Sandboxed Claude Code environments" for the `executablePath` workaround and revert it before committing.

- [ ] **Step 9: Commit**

```bash
npm run format
git add client/src/mode-announce.ts tests/client/src/mode-announce.test.ts client/src/collab.ts tests/e2e/collab/mode-switcher.spec.ts
git commit -m "$(cat <<'EOF'
feat(collab): flash a toast when the collab mode changes (mode announce)

New mode-announce.ts: a pure nextAnnouncement() decides when to flash,
initModeAnnounce() wires effectiveMode → showToast. Fires on a mode
switch and on first entry to a shared workspace per page-load; not on
doc switches within a workspace, workspace re-entry, or plain local docs.
Rapid switching replaces the prior mode toast rather than stacking.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Release 1.55.0

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Create: `client/public/whats-new/mode-announce.png`
- Create: `tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs`
- Modify: `docs/TEST-COVERAGE.md`
- Modify: `ROADMAP.md`

**Interfaces:** none.

**Context an implementer needs:**
- `package.json` `"version"` is `1.54.0` (v1.54.0 just merged). `package-lock.json` has **two** `"version": "1.54.0"` lines — top-level (~line 3) and `packages."".version` (~line 9). Hand-edit both.
- `CHANGELOG.md`'s newest section is `## [1.54.0] - 2026-09-08`. Insert the new one directly above it.
- `client/src/whats-new-entries.ts` — `WHATS_NEW_ENTRIES` array, oldest-first, append at the end. Entry shape: `{ version, title, description, screenshot, category }` — **no date field**. `screenshot` must match `/^\/whats-new\/[\w-]+\.(png|jpg|webp)$/`.
- Screenshot-capture pattern: copy `tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs` (from v1.54.0) or `capture-request-access-screenshot.mjs`. Flow: `bash tests/scripts/manual-testing/enable-dev-login.sh` → `npm run build` → `npm run dev` (wrangler, :8787) → the script → `pkill -f "wrangler dev"` → `bash tests/scripts/manual-testing/disable-dev-login.sh` → verify `git diff --quiet src/worker.ts`. `enable-dev-login.sh` refuses if `src/worker.ts` has uncommitted changes — there are none here.
- The screenshot must show the actual toast. The mode toast auto-dismisses after 3200 ms, so the script must switch mode and screenshot within that window.

- [ ] **Step 1: Version bump**

- `package.json`: `"version": "1.54.0"` → `"1.55.0"`.
- `package-lock.json`: both `"version": "1.54.0"` → `"1.55.0"` (lines ~3 and ~9).

Verify: `grep -n '"version": "1.5[45].0"' package.json package-lock.json` shows only `1.55.0`.

- [ ] **Step 2: CHANGELOG**

Insert above `## [1.54.0] - 2026-09-08` in `CHANGELOG.md` (use the real current date):

```markdown
## [1.55.0] - <today>

### Added

- **A heads-up when your mode changes in a shared document.** Switching between Editing, Suggesting, and Viewing — or opening a shared workspace — now flashes a brief "You're now suggesting" / "You're now viewing" message, so it's clear what your edits will do.
```

- [ ] **Step 3: What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.55.0",
    title: "Know Which Mode You're In",
    description:
      "In a shared document, switching between Editing, Suggesting, and Viewing — or just opening the workspace — now flashes a quick note like \"You're now suggesting\". A small reminder that your keystrokes become tracked suggestions, or that you're read-only, without hunting for the mode switcher in the corner.",
    screenshot: "/whats-new/mode-announce.png",
    category: "Collaboration",
  },
```

- [ ] **Step 4: Write the screenshot-capture script**

Create `tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs`:

```js
// One-off: capture client/public/whats-new/mode-announce.png — a
// collaborator switches to Suggesting and the "You're now suggesting"
// toast is on screen.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/mode-announce.png";

const browser = await chromium.launch();
const ownerCtx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const editorCtx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const owner = await ownerCtx.newPage();
const editor = await editorCtx.newPage();

async function signIn(page, username) {
  await page.route("**/api/auth/github/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) }),
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}
async function dismissWhatsNew(page) {
  const b = page.locator('button:has-text("Got it")');
  if (await b.isVisible({ timeout: 2000 }).catch(() => false)) await b.click();
}

await signIn(owner, "ma-owner");
await signIn(editor, "ma-editor");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn").catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Launch plan\n\nFeedback welcome before Thursday.");

await owner.click('button:has-text("Share")');
await owner.locator('button:has-text("Continue")').click({ timeout: 2000 }).catch(() => {});
await owner.locator('select[aria-label="General access"]').selectOption({ label: "Anyone with the link" });
await owner.locator('select[aria-label="Access level for people with the link"]').selectOption({ label: "Editor" });
const state = await owner.evaluate(() => {
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const activeId = localStorage.getItem("mde:active");
  const doc = docs.find((d) => d.id === activeId);
  return { doc, ws: wss.find((w) => w.id === doc?.workspaceId) };
});
await owner.locator('button:has-text("Done")').click({ timeout: 2000 }).catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});

await editor.goto(`${BASE}/w/${state.ws.remoteId}/${state.doc.id}/edit`);
await editor.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const join = editor.locator('button:has-text("Add as new workspace")');
if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click();
await dismissWhatsNew(editor);
await editor.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Launch plan"), { timeout: 15000 });

// Switch to Suggesting → the toast appears; capture within its 3.2s life.
await editor.click(".mode-switcher-btn");
await editor.click('.mode-switcher-menu [role="menuitem"]:has-text("Suggesting")');
await editor.locator('.toast:has-text("You\'re now suggesting")').waitFor({ timeout: 3000 });
await editor.waitForTimeout(250);
await editor.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await editorCtx.close();
await browser.close();
```

- [ ] **Step 5: Capture the screenshot**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npm run dev > /tmp/dev-mode-announce.log 2>&1 &
# wait until: curl -sf http://localhost:8787/ succeeds
node tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs
pkill -f "wrangler dev"
bash tests/scripts/manual-testing/disable-dev-login.sh
git diff --quiet src/worker.ts && echo "worker.ts clean"
```

Open `client/public/whats-new/mode-announce.png` and confirm the "You're now suggesting" toast is visible at the bottom. Re-run if it fired too fast (increase the pre-screenshot `waitForTimeout`, but stay under 3200 ms total after the toast appears).

- [ ] **Step 6: Verify the whats-new screenshot test**

Run: `npx vitest run tests/client/src/whats-new-entries.test.ts`
Expected: PASS (the `mode-announce.png` file now exists).

- [ ] **Step 7: TEST-COVERAGE row**

In `docs/TEST-COVERAGE.md`, in the "App shell" section (near `SHELL-24..27` added in v1.54.0), add:

```markdown
| SHELL-28 | Mode announcement — `nextAnnouncement(prev, next, seen)` flashes a toast on a real mode change within a workspace and on first entry to an unseen workspace (marking it seen); silent on unchanged mode, doc-switch within a seen workspace, workspace re-entry, leaving, and plain local docs; `initModeAnnounce` wires `effectiveMode` → `showToast` and replaces the prior mode toast; e2e a collaborator switching Editing → Viewing sees "You're now viewing" | unit + e2e-collab | covered | `tests/client/src/mode-announce.test.ts`, `tests/e2e/collab/mode-switcher.spec.ts` | v1.55.0 |
```

- [ ] **Step 8: ROADMAP note**

In `ROADMAP.md`, under "Google Docs parity — features we don't have yet", change the **"Persistent mode badge on the document"** bullet to:

```markdown
- [x] **Transient mode indicator — shipped v1.55.0.** The roadmap's
      original "persistent chip" wording was wrong — Google's indicator
      is momentary. Shipped as a toast: a mode switch, or first entry to
      a shared workspace per page-load, flashes "You're now editing /
      suggesting / viewing" (spec
      `docs/superpowers/specs/2026-09-09-mode-announce-design.md`). A
      dedicated on-document badge component was considered and deferred
      (see that spec's Non-goals).
```

Also add to the "Deferred considerations" section:

```markdown
- [ ] An on-document mode badge component (top-centre pill, mode icon,
      slide-in) instead of the plain toast shipped in v1.55.0 — revisit
      if the toast proves too easy to miss
```

- [ ] **Step 9: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
```
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/mode-announce.png tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs docs/TEST-COVERAGE.md ROADMAP.md
git commit -m "$(cat <<'EOF'
chore: release 1.55.0 — transient mode announcement toast

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Open the PR**

```bash
git push -u origin docs/mode-announce-spec
gh pr create --title "Transient mode announcement toast — v1.55.0" --body "$(cat <<'EOF'
## What

A mode switch, or first entry to a shared workspace per page-load, flashes a toast: "You're now editing / suggesting / viewing". Reuses the existing bottom-center toast stack — no new visual component.

- New `client/src/mode-announce.ts` — a pure `nextAnnouncement(prev, next, seen)` (the tested core) + a thin `initModeAnnounce()` subscribing `effectiveMode` → `showToast`.
- `showToast` now returns its id, so the module dismisses the prior mode toast before the next (no stacking on rapid switching).
- Not triggered: doc-switches within a workspace already seen, workspace re-entry, leaving, plain local docs.

Spec: `docs/superpowers/specs/2026-09-09-mode-announce-design.md`
Plan: `docs/superpowers/plans/2026-09-09-mode-announce.md`

## Release

v1.55.0 — CHANGELOG + What's New entry (with screenshot) + TEST-COVERAGE row SHELL-28. ROADMAP "persistent mode badge" item closed (the transient toast is the agreed shape; an on-document badge is deferred).

## Tests

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, and `npm run test:e2e:collab` (incl. the mode-switcher toast assertions) green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 12: Watch CI, merge on green** (after the user confirms) — `auto-tag.yml` tags `v1.55.0` → `release.yml` → Cloudflare auto-deploys.

---

## Self-Review

**1. Spec coverage:**
- `showToast` returns id → Task 1. ✅
- `MODE_ANNOUNCE_COPY` exact strings → Task 2 Step 3 + test Step 1. ✅
- Pure `nextAnnouncement(prev, next, seen)` with all 7 spec table cases → Task 2 Step 1 covers every row (plain local, first entry, switch, unchanged+seen, re-entry, leave, different-unseen-workspace). ✅
- `initModeAnnounce()` subscribes `effectiveMode`, reads `collabRemoteId` via `get`, dismisses prior toast → Task 2 Step 3. ✅
- Wired into `collab.ts` at module load next to the existing subscription → Task 2 Step 5. ✅
- Not triggered on local docs / leave / re-entry / intra-workspace doc switch → covered by the `nextAnnouncement` cases + the spec's note that `effectiveMode` doesn't fire on doc rebind (Task 2 context). ✅
- e2e assertion on mode-switcher spec → Task 2 Step 7. ✅
- Toast-store test for the returned id → Task 1 Step 1. ✅
- Release: version (both lockfile fields), CHANGELOG `### Added`, What's New entry + real screenshot + capture script, TEST-COVERAGE row, ROADMAP close + deferred-considerations line → Task 3. ✅
- Non-goal "no dedicated badge component" — honored (toast only). ✅
- Non-goal "no mode icon in toast" — honored (plain `showToast` string). ✅

**2. Placeholder scan:** No "TBD" / "handle edge cases" / "similar to Task N". `<today>` / `<date>` in Task 3 is a fill-at-commit token with an explicit instruction ("use the real current date"). Line-number references (`~line 3`, `~line 279`) are hints with `grep` fallbacks. Acceptable.

**3. Type/name consistency:**
- `showToast(...): number` — defined Task 1, consumed Task 2 (`lastToastId = showToast(...)`).
- `dismissToast(id: number)` — existing export, used Task 2.
- `ModeState { remoteId: string | null; mode: Mode | null }` — defined Task 2 Step 3, used identically in the test (Step 1, via `type ModeState` import).
- `nextAnnouncement(prev, next, seen)` — same signature in test and impl.
- `MODE_ANNOUNCE_COPY` — same keys/values in impl (Step 3) and test (Step 1) and CHANGELOG/What's New copy (Task 3).
- `collabRemoteId`, `effectiveMode`, `Mode` — imported from `./stores/collabMode`, which exports all three (verified against the file).
- `initModeAnnounce` — exported Task 2 Step 3, imported/called Task 2 Step 5.
- Screenshot path `client/public/whats-new/mode-announce.png` — consistent across the capture script (Task 3 Step 4), the What's New entry (Step 3), and the file list.

No gaps found.
