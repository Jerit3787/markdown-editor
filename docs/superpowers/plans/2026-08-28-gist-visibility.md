# Gist Publish Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user choose Public vs Secret the first time a document is published to Gist, since GitHub's API only accepts that field at creation and never afterward.

**Architecture:** A new promise-based dialog (mirroring the existing `ConfirmDialog`/`confirmDialog.ts` pattern exactly) is shown only when `gist.ts`'s `publish()` is about to create a brand-new gist (`!doc.gistId`); its resolved choice replaces today's hardcoded `public: false` in that one `POST` call. Every subsequent "Update Gist" on the same document is untouched.

**Tech Stack:** Svelte 5, `vitest-browser-svelte` (component tests, real Chromium).

**Spec:** `docs/superpowers/specs/2026-08-28-gist-visibility-design.md`

## Global Constraints

- Visibility can only ever be set at gist creation — never touch the `PATCH` (update) branch of `publish()`.
- No comment-related UI of any kind — GitHub has no such capability.
- No UI anywhere that displays or lets the user change an existing gist's visibility after publish.

---

### Task 1: `GistVisibilityDialog` store + component + mounting

**Files:**
- Create: `client/src/stores/gistVisibilityDialog.ts`
- Create: `client/src/components/GistVisibilityDialog.svelte`
- Modify: `client/src/main.ts`
- Modify: `client/index.html`
- Test: `tests/client/src/components/GistVisibilityDialog.test.ts` (new)

**Interfaces:**
- Consumes: `Modal` component (`client/src/components/Modal.svelte`, existing — `title`/`icon`/`labelledBy`/`onClose`/`footer` snippet props, already used identically by `ConfirmDialog.svelte`).
- Produces: `chooseGistVisibility(): Promise<"public" | "secret" | null>` — the only symbol Task 2 needs, exported from `client/src/stores/gistVisibilityDialog.ts`. `null` means canceled.

- [ ] **Step 1: Write the failing tests**

Create `tests/client/src/components/GistVisibilityDialog.test.ts`:

```ts
import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";
import GistVisibilityDialog from "../../../../client/src/components/GistVisibilityDialog.svelte";
import { chooseGistVisibility } from "../../../../client/src/stores/gistVisibilityDialog";

test("defaults to Secret and resolves it when Publish is clicked without changing the selection", async () => {
  const resultPromise = chooseGistVisibility();
  const screen = await render(GistVisibilityDialog);

  await expect.element(screen.getByRole("combobox")).toHaveValue("secret");
  await screen.getByRole("button", { name: "Publish" }).click();

  await expect(resultPromise).resolves.toBe("secret");
});

test("selecting Public and clicking Publish resolves \"public\"", async () => {
  const resultPromise = chooseGistVisibility();
  const screen = await render(GistVisibilityDialog);

  await screen.getByRole("combobox").selectOptions("public");
  await screen.getByRole("button", { name: "Publish" }).click();

  await expect(resultPromise).resolves.toBe("public");
});

test("Cancel resolves null", async () => {
  const resultPromise = chooseGistVisibility();
  const screen = await render(GistVisibilityDialog);

  await screen.getByRole("button", { name: "Cancel" }).click();

  await expect(resultPromise).resolves.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/GistVisibilityDialog.test.ts`
Expected: FAIL — neither `client/src/stores/gistVisibilityDialog.ts` nor `client/src/components/GistVisibilityDialog.svelte` exist yet, so the imports fail to resolve.

- [ ] **Step 3: Create the store**

Create `client/src/stores/gistVisibilityDialog.ts`:

```ts
import { writable } from "svelte/store";

interface GistVisibilityRequest {
  resolve: (visibility: "public" | "secret" | null) => void;
}

export const gistVisibilityRequest = writable<GistVisibilityRequest | null>(null);

export function chooseGistVisibility(): Promise<"public" | "secret" | null> {
  return new Promise((resolve) => {
    gistVisibilityRequest.set({ resolve });
  });
}
```

- [ ] **Step 4: Create the component**

Create `client/src/components/GistVisibilityDialog.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { gistVisibilityRequest } from "../stores/gistVisibilityDialog";

  let choice = $state<"secret" | "public">("secret");

  function respond(visibility: "public" | "secret" | null) {
    $gistVisibilityRequest?.resolve(visibility);
    gistVisibilityRequest.set(null);
    choice = "secret";
  }
</script>

{#if $gistVisibilityRequest}
  <Modal title="Publish to Gist" icon="icon-rocket" labelledBy="gistVisibilityTitle" onClose={() => respond(null)}>
    <div class="empty-state" style="padding: 12px 0 24px;">
      <svg class="empty-state-icon"><use href="#icon-info"></use></svg>
      <label for="gistVisibilitySelect" class="menu-section-label" style="margin-top: 16px;">Visibility</label>
      <select id="gistVisibilitySelect" bind:value={choice}>
        <option value="secret">Secret</option>
        <option value="public">Public</option>
      </select>
      <div class="empty-state-desc" style="margin-top: 12px;">
        Secret gists aren't listed publicly, but anyone with the link can view them. Public gists are listed on your GitHub profile and
        discoverable by anyone. <strong>This can't be changed after publishing</strong> — GitHub has no way to convert a gist's
        visibility once it's created.
      </div>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={() => respond(null)}>Cancel</button>
      <button type="button" class="primary-btn" onclick={() => respond(choice)}>Publish</button>
    {/snippet}
  </Modal>
{/if}
```

- [ ] **Step 5: Mount the component**

In `client/index.html`, add a new mount point directly after the existing `#confirm-dialog-mount` div:

```html
<div id="gist-visibility-dialog-mount"></div>
```

In `client/src/main.ts`, add the import directly after the existing `import ConfirmDialog from "./components/ConfirmDialog.svelte";` line:

```ts
import GistVisibilityDialog from "./components/GistVisibilityDialog.svelte";
```

And add the mount call directly after the existing `mount(ConfirmDialog, { target: document.getElementById("confirm-dialog-mount")! });` line:

```ts
mount(GistVisibilityDialog, { target: document.getElementById("gist-visibility-dialog-mount")! });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project=components tests/client/src/components/GistVisibilityDialog.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add client/src/stores/gistVisibilityDialog.ts client/src/components/GistVisibilityDialog.svelte client/src/main.ts client/index.html tests/client/src/components/GistVisibilityDialog.test.ts
git commit -m "feat: add a visibility-choice dialog for first-time Gist publishing"
```

---

### Task 2: Wire the dialog into `publish()`, version/changelog/whats-new, and final verification

**Files:**
- Modify: `client/src/gist.ts`
- Modify: `package.json`, `package-lock.json` (two `"version"` fields)
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md`
- Create: `client/public/whats-new/gist-visibility.png`

**Interfaces:**
- Consumes: `chooseGistVisibility(): Promise<"public" | "secret" | null>` from Task 1.
- Produces: nothing new for other code — this task's `publish()` change is the final consumer in this plan.

- [ ] **Step 1: Modify `publish()`**

In `client/src/gist.ts`, add a new import directly after the existing `import { get } from "svelte/store";` line:

```ts
import { chooseGistVisibility } from "./stores/gistVisibilityDialog";
```

In the `publish()` function, insert a new block directly after the existing `if (!doc) return;` line and before `const content = window.MDE.getResolvedContent();`:

```ts
  let isPublic = false;
  if (!doc.gistId) {
    const visibility = await chooseGistVisibility();
    if (visibility === null) return; // canceled — no gist created
    isPublic = visibility === "public";
  }
```

Change the existing `POST /api/gist` call's body (the one inside the `else` branch that creates a brand-new gist) from:

```ts
        body: JSON.stringify({ description: doc.name || "Untitled", public: false, files: { [filename]: { content } } }),
```

to:

```ts
        body: JSON.stringify({ description: doc.name || "Untitled", public: isPublic, files: { [filename]: { content } } }),
```

The `PATCH` (update) branch above it is untouched.

- [ ] **Step 2: Run typecheck and the full unit/component suite**

Run: `npm run typecheck && npm test`
Expected: both pass with no new errors or warnings.

- [ ] **Step 3: Manual verification**

`gist.ts` has no existing automated test coverage of any kind (confirmed in the design spec — GitHub-auth-gated flows are verified manually per this repo's own convention). Using the `dev-login` manual-testing patch (`tests/scripts/manual-testing/enable-dev-login.sh`) and a real GitHub OAuth App:

1. Run `bash tests/scripts/manual-testing/enable-dev-login.sh`, then `npm run dev`.
2. Open a fresh document, sign in with GitHub, click "Publish to Gist".
3. Confirm the new dialog appears with "Secret" selected by default.
4. Click Cancel — confirm no network request fires (check the Network tab) and no gist link appears in the File menu.
5. Click "Publish to Gist" again, this time select "Public", click Publish — confirm the gist is created (File menu now shows "Update Gist" / "View Gist"), and that visiting the gist's URL while signed out of GitHub in a private window shows it (public gists are visible to anyone; a secret one would also technically be reachable by URL, so the real check is that it doesn't show a "Secret Gist" label and — if the account allows it — that it's listed on the account's public gists page at `https://gist.github.com/<username>`).
6. Click "Update Gist" (edit the doc first so there's a change) — confirm the dialog does **not** appear the second time.
7. Run `bash tests/scripts/manual-testing/disable-dev-login.sh` and confirm `git status --porcelain -- src/worker.ts` is clean afterward.

- [ ] **Step 4: Bump the version**

Read the current version from `package.json` first (it may have changed since this plan was written). Bump the minor version in both `package.json` and **both** `"version"` fields in `package-lock.json`.

- [ ] **Step 5: Add the CHANGELOG entry**

Add a new section to `CHANGELOG.md`, directly above the current top entry, using the version bumped in Step 4 and today's date:

```markdown
## [<NEW_VERSION>] - 2026-08-28

### Added

- **Choose a Gist's visibility when first publishing it.** Publishing a document to Gist for the first time now asks Secret (default, matches previous behavior) or Public before creating it — GitHub's API only accepts this choice at creation time and never lets it be changed afterward, so later "Update Gist" actions on the same document are unaffected and show no prompt.
```

- [ ] **Step 6: Capture the What's New screenshot**

Using the `dev-login` patch from Step 3 (or a mocked `window.print`-style approach isn't applicable here since this needs real interactive state), start `npm run dev` with dev-login enabled, sign in, click "Publish to Gist" on a fresh document, and screenshot the open `GistVisibilityDialog` (showing the Visibility dropdown and the "can't be changed" copy) at roughly 1200×630. Save to `client/public/whats-new/gist-visibility.png`. Run `bash tests/scripts/manual-testing/disable-dev-login.sh` afterward and confirm `git status --porcelain -- src/worker.ts` is clean.

- [ ] **Step 7: Add the What's New entry**

Append to the end of the `WHATS_NEW_ENTRIES` array in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "<NEW_VERSION>",
    title: "Choose Gist Visibility",
    description:
      "Publishing a document to Gist for the first time now lets you choose Public or Secret before it's created — GitHub only accepts this choice at creation, so it can't be changed later, and updating an already-published document skips the prompt.",
    screenshot: "/whats-new/gist-visibility.png",
  },
```

- [ ] **Step 8: Check off the IMPROVEMENTS.md item**

Change:

```markdown
- [ ] Gist management menu — permanently set a Gist public, enable/
      disable commenting on it.
```

to:

```markdown
- [x] Gist management menu. (Shipped v<NEW_VERSION> as a one-time
      public/secret choice at first publish — GitHub's API doesn't
      support changing an existing gist's visibility or toggling
      comments at all, so neither of those two original asks was
      buildable; see the design spec's feasibility finding.)
```

- [ ] **Step 9: Run final verification suite**

Run in order:

```bash
npm run typecheck
npm run format:check
npm test
npm run build
```

Expected: all green. If `format:check` fails, run `npm run format` and re-check.

- [ ] **Step 10: Commit**

```bash
git add client/src/gist.ts package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md client/public/whats-new/gist-visibility.png
git commit -m "feat: ask for Gist visibility on first publish"
```
