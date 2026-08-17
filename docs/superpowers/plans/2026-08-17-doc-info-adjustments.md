# Document Info Adjustments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give relative dates a granular "Nd ago / Nw ago / Nmo ago" ladder instead of jumping straight to a bare date, and surface a document's linked GitHub repo/Gist in the Document info panel.

**Architecture:** Extract the existing `formatRelativeTime` closure function out of `app.ts` into a small standalone module (`relative-time.ts`), upgrade its ladder there (now unit-testable in isolation), and re-import it for the `window.MDE` bridge — every existing caller (Open Recent, Command Palette, Document info) picks up the richer output automatically with no call-site changes. Separately, `DocInfoPanel.svelte` gains a new "Synced to" section reading `doc.repoPath` + the doc's workspace's `repoLink`, and `doc.gistId`, linking out to the file/gist on GitHub.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

## Global Constraints

- `formatRelativeTime`'s exact ladder: `<1 day` → `"Today"`; `<2 days` → `"Yesterday"`; `<7 days` → `"{n}d ago"`; `<30 days` → `"{n}w ago"` (n = `Math.floor(days / 7)`); `<365 days` → `"{n}mo ago"` (n = `Math.floor(days / 30)`); `>=365 days` → full date with year (`toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })`). `days` itself is `Math.floor((Date.now() - ts) / 86400000)`.
- No signature change to `formatRelativeTime(ts: number): string` — every existing call site (`MenuBar.svelte`, `CommandPalette.svelte`, `DocInfoPanel.svelte`, `window.MDE.formatRelativeTime` in `types.ts`) keeps working unmodified.
- The new "Synced to" section in `DocInfoPanel.svelte` renders nothing (not even its label) when the doc has neither `repoPath` nor `gistId`.
- Keep every row in `DocInfoPanel.svelte` as a `<div class="doc-info-row">` (never `<a class="doc-info-row">`) — `style.css`'s `.doc-info-row:last-of-type { border-bottom: none; }` rule matches per-tag-type, and mixing tag types on that class would break which row actually loses its border.

---

### Task 1: Extract and upgrade `formatRelativeTime`

**Files:**
- Create: `client/src/relative-time.ts`
- Test: `client/src/relative-time.test.ts`
- Modify: `client/src/app.ts`

**Interfaces:**
- Produces: `export function formatRelativeTime(ts: number): string;` in `client/src/relative-time.ts`.

- [ ] **Step 1: Write the failing test**

Create `client/src/relative-time.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-08-17T12:00:00Z").getTime();
  const DAY = 86400000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Today' for a timestamp less than a day old", () => {
    expect(formatRelativeTime(NOW - 1000)).toBe("Today");
    expect(formatRelativeTime(NOW)).toBe("Today");
  });

  it("returns 'Yesterday' for a timestamp 1-2 days old", () => {
    expect(formatRelativeTime(NOW - DAY)).toBe("Yesterday");
    expect(formatRelativeTime(NOW - DAY - 1000)).toBe("Yesterday");
  });

  it("returns '{n}d ago' for 2-6 days old", () => {
    expect(formatRelativeTime(NOW - 2 * DAY)).toBe("2d ago");
    expect(formatRelativeTime(NOW - 6 * DAY)).toBe("6d ago");
  });

  it("returns '{n}w ago' for 7-29 days old, rounded down to whole weeks", () => {
    expect(formatRelativeTime(NOW - 7 * DAY)).toBe("1w ago");
    expect(formatRelativeTime(NOW - 13 * DAY)).toBe("1w ago");
    expect(formatRelativeTime(NOW - 14 * DAY)).toBe("2w ago");
    expect(formatRelativeTime(NOW - 29 * DAY)).toBe("4w ago");
  });

  it("returns '{n}mo ago' for 30-364 days old, rounded down to whole months", () => {
    expect(formatRelativeTime(NOW - 30 * DAY)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 59 * DAY)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 60 * DAY)).toBe("2mo ago");
    expect(formatRelativeTime(NOW - 364 * DAY)).toBe("12mo ago");
  });

  it("returns a full date with year for 365+ days old", () => {
    const ts = NOW - 365 * DAY;
    expect(formatRelativeTime(ts)).toBe(new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/relative-time.test.ts`
Expected: FAIL — `./relative-time` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `client/src/relative-time.ts`:

```ts
const DAY = 86400000;

// window.MDE.formatRelativeTime — used by MenuBar.svelte's Open Recent
// submenu, CommandPalette.svelte's sublabels, and DocInfoPanel.svelte's
// Created/Edited rows (paired there with a full timestamp). One shared
// ladder for all three: bare "Today"/"Yesterday" for the last two days,
// then day/week/month buckets before falling back to a full date once
// "months ago" stops being a useful approximation.
export function formatRelativeTime(ts: number): string {
  const days = Math.floor((Date.now() - ts) / DAY);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/relative-time.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Wire it into `app.ts`**

In `client/src/app.ts`, add a new import below the existing `import type { Doc, MDEBridge } from "./types";` line:

```ts
import { formatRelativeTime } from "./relative-time";
```

Remove the local function definition (currently around line 257):

```ts
  function formatRelativeTime(ts: number) {
    const diff = Date.now() - ts;
    const day = 86400000;
    if (diff < day) return "Today";
    if (diff < day * 2) return "Yesterday";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
```

Leave the `formatRelativeTime,` property shorthand in the `window.MDE` bridge object literal (near the bottom of the file, in the object that gets assigned to `window.MDE`) exactly as it is — it now refers to the imported function instead of the local one, no other change needed there.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 6 new ones.

- [ ] **Step 8: Commit**

```bash
git add client/src/relative-time.ts client/src/relative-time.test.ts client/src/app.ts
git commit -m "feat: extract formatRelativeTime, add day/week/month ladder"
```

---

### Task 2: "Synced to" section in Document info

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte`
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `workspacesStore` (`../stores/workspaces`, already exists — `Workspace[]`, each with an optional `repoLink: { owner, repo, branch }`); `doc.repoPath`/`doc.gistId` (already on `Doc`, `../types`).

- [ ] **Step 1: Add the `workspacesStore` import**

In `client/src/components/DocInfoPanel.svelte`, change:

```svelte
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
```

to:

```svelte
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
```

- [ ] **Step 2: Add the "Synced to" section**

In the same file, change:

```svelte
    <div class="doc-info-row">
      <span class="doc-info-primary">Length</span>
      <span class="doc-info-secondary">{wordCount} word{wordCount === 1 ? "" : "s"}, {charCount} character{charCount === 1 ? "" : "s"}</span>
    </div>
    <div class="menu-section-label">Linked from</div>
```

to:

```svelte
    <div class="doc-info-row">
      <span class="doc-info-primary">Length</span>
      <span class="doc-info-secondary">{wordCount} word{wordCount === 1 ? "" : "s"}, {charCount} character{charCount === 1 ? "" : "s"}</span>
    </div>
    {#if doc.repoPath || doc.gistId}
      <div class="menu-section-label">Synced to</div>
      {#if doc.repoPath}
        {@const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId)}
        {#if workspace?.repoLink}
          <div class="doc-info-row">
            <span class="doc-info-primary">Repo</span>
            <a
              class="doc-info-secondary doc-info-link"
              href={`https://github.com/${workspace.repoLink.owner}/${workspace.repoLink.repo}/blob/${workspace.repoLink.branch}/${doc.repoPath}`}
              target="_blank"
              rel="noopener"
            >
              {workspace.repoLink.owner}/{workspace.repoLink.repo} — {doc.repoPath}
            </a>
          </div>
        {/if}
      {/if}
      {#if doc.gistId}
        <div class="doc-info-row">
          <span class="doc-info-primary">Gist</span>
          <a class="doc-info-secondary doc-info-link" href={`https://gist.github.com/${doc.gistId}`} target="_blank" rel="noopener">
            View on GitHub
          </a>
        </div>
      {/if}
    {/if}
    <div class="menu-section-label">Linked from</div>
```

- [ ] **Step 3: Add `.doc-info-link` styling**

In `client/src/style.css`, change:

```css
.doc-info-backlink-row { text-align: left; border: none; background: var(--bg-alt); border-radius: 6px; padding: 6px 10px; cursor: pointer; font-family: inherit; font-size: 13px; }
.doc-info-backlink-row:hover { background: var(--border); }
```

to:

```css
.doc-info-backlink-row { text-align: left; border: none; background: var(--bg-alt); border-radius: 6px; padding: 6px 10px; cursor: pointer; font-family: inherit; font-size: 13px; }
.doc-info-backlink-row:hover { background: var(--border); }
.doc-info-link { text-decoration: none; }
.doc-info-link:hover, .doc-info-link:focus-visible { color: var(--accent); text-decoration: underline; }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Manual verification**

Run the dev server (`npm run dev:client`). This codebase has no automated tests for Svelte component markup (verified: no `*.svelte.test.ts` files exist anywhere under `client/src/components/`) — UI changes are checked live, per established practice.

Open a document, open Document info (File > Document info), and check three cases:
1. **Unlinked doc** (no `repoPath`, no `gistId`): confirm no "Synced to" label appears at all — the panel goes straight from Length to "Linked from".
2. **Repo-linked doc**: via the browser console or Chrome MCP `javascript_tool`, set a fake `repoPath`/workspace `repoLink` directly on the store to simulate a synced doc, e.g.:
   ```js
   const docsMod = await import('/src/stores/docs.ts');
   const wsMod = await import('/src/stores/workspaces.ts');
   const doc = docsMod.getActiveDoc();
   wsMod.workspacesStore.update(all => all.map(w => w.id === doc.workspaceId ? { ...w, repoLink: { owner: "octocat", repo: "notes", branch: "main" } } : w));
   docsMod.docsStore.update(all => all.map(d => d.id === doc.id ? { ...d, repoPath: "docs/notes.md" } : d));
   ```
   Reopen Document info — confirm the "Synced to" section appears with a "Repo" row reading `octocat/notes — docs/notes.md`, and that clicking it opens `https://github.com/octocat/notes/blob/main/docs/notes.md` in a new tab.
3. **Gist-linked doc**: similarly set `gistId` on the active doc and confirm a "Gist" row appears, linking to `https://gist.github.com/<id>`.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/DocInfoPanel.svelte client/src/style.css
git commit -m "feat: show linked repo/gist info in Document info panel"
```

---

### Task 3: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including the 6 new `formatRelativeTime` tests.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated to this work).

- [ ] **Step 4: Spot-check the other two `formatRelativeTime` call sites**

In the dev server, open File > Open Recent and the Command Palette — confirm document timestamps in both now show the richer ladder (e.g. a doc edited a few days ago shows "3d ago" instead of a bare date) for any test data old enough to hit those buckets. If everything in the workspace is from today, this step can't observe a difference — that's fine, Task 1's unit tests already cover every rung directly.
