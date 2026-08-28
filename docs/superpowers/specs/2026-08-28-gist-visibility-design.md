# Gist Publish Visibility — Design Spec

**IMPROVEMENTS.md Phase 2 item:** "Gist management menu — permanently set a Gist public, enable/disable commenting on it."

## Feasibility finding (why this spec is narrower than the backlog item)

GitHub's Gist REST API does not support either half of the backlog item as literally worded:

- **Visibility (`public`/secret) is only settable at creation** (`POST /gists`). The update endpoint (`PATCH /gists/{gist_id}`) accepts only `description` and `files` — there is no way, via API or GitHub's own web UI, to convert an existing gist's visibility after it's created. The only workaround is deleting the gist and recreating it under a new ID/URL, which breaks every existing link to it.
- **Gist comments have no enable/disable control anywhere** — not in the API, not in the web UI. There is nothing to build against.

This app currently always creates gists as `public: false` (hardcoded in `client/src/gist.ts:131`, `POST /api/gist` → `handleGistCreate` in `src/github-auth.ts`, which proxies the request body to GitHub's `/gists` endpoint verbatim). Confirmed with the user: this spec covers only what's actually possible — a one-time visibility choice made at the moment a document is first published, since that's the one point where GitHub's API genuinely accepts the field. Converting an already-published gist's visibility (delete+recreate) and any comment-related control are both explicitly out of scope (see Non-goals).

## Goal

- The first time a document is published to Gist (`doc.gistId` not yet set), a small dialog asks the user to choose **Secret** (default, matches today's existing behavior) or **Public** before the gist is created, with copy making clear the choice can't be changed later.
- Choosing **Public** creates the gist with `public: true`; choosing **Secret** (or accepting the default) creates it with `public: false`, exactly as today.
- Canceling the dialog aborts the publish — no gist is created, no network request is made.
- Every subsequent "Update Gist" action on that same document (`doc.gistId` already set) behaves exactly as today: no dialog, straight to the `PATCH` call. This isn't a workaround — sending `public` in a PATCH body is simply ignored by GitHub's API, so there's nothing this dialog could accomplish on repeat publishes even if shown.

## Non-goals (deferred)

- **No comment enable/disable control.** GitHub Gists have no such capability at all; there's nothing to build.
- **No way to change an existing gist's visibility after publish.** Would require delete+recreate under a new gist ID, breaking every existing link/embed pointing at the old one — explicitly rejected when this was raised with the user.
- **No display of a gist's current visibility** in the app's UI (e.g., on the "View Gist" link or Document Info panel). The app doesn't track or fetch this today, and nothing in this spec needs it.
- **No change to the "Open from GitHub Gist" or gist-listing flows** (`openGistPicker`) — this spec touches only the publish path.

## Components

### `client/src/stores/gistVisibilityDialog.ts` (new)

Mirrors the existing promise-based pattern in `stores/confirmDialog.ts` exactly, just with a three-way result instead of a boolean:

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

`null` means "canceled" (the modal's close button, the Cancel button, or clicking the backdrop) — `gist.ts`'s `publish()` treats this as "abort, don't publish."

### `client/src/components/GistVisibilityDialog.svelte` (new)

Modeled directly on `ConfirmDialog.svelte`'s structure (same `Modal` wrapper, same `.primary-btn`/`.secondary-btn` footer pattern), swapping the yes/no body for a visibility `<select>`:

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

No new CSS needed — `_share-workspace.scss`'s existing generic `select:not(.share-access-select):not(.share-role-select)` rule already styles any plain `<select>`, which this is.

### `client/src/main.ts` (modify)

Mount the new dialog the same way every other global dialog/modal is mounted (directly after the existing `ConfirmDialog` mount, since they're conceptually siblings):

```ts
import GistVisibilityDialog from "./components/GistVisibilityDialog.svelte";
// ...
mount(GistVisibilityDialog, { target: document.getElementById("gist-visibility-dialog-mount")! });
```

### `client/index.html` (modify)

New mount point, directly after `#confirm-dialog-mount`:

```html
<div id="gist-visibility-dialog-mount"></div>
```

### `client/src/gist.ts` (modify)

`publish()` gains one new branch at its top, before the existing `wasUpdate`/progress-toast setup — only for a document that has never been published (`!doc.gistId`):

```ts
import { chooseGistVisibility } from "./stores/gistVisibilityDialog";
```

```ts
async function publish() {
  if (!connectedUsername) {
    window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;

  let isPublic = false;
  if (!doc.gistId) {
    const visibility = await chooseGistVisibility();
    if (visibility === null) return; // canceled — no gist created
    isPublic = visibility === "public";
  }

  // ...unchanged...
```

The single existing `POST /api/gist` call's body changes from the hardcoded `public: false` to `public: isPublic`:

```ts
body: JSON.stringify({ description: doc.name || "Untitled", public: isPublic, files: { [filename]: { content } } }),
```

The `PATCH` (update) branch is untouched — it never sent `public` before and still doesn't, since `doc.gistId` being set means the new branch above never ran and `isPublic` is left at its unused default.

## Testing

- **`tests/client/src/components/GistVisibilityDialog.test.ts` (new, `components` Vitest project):** mount `GistVisibilityDialog`, call `chooseGistVisibility()` from the test, assert the dialog renders with "Secret" selected by default; select "Public" and click the Publish button, assert the returned promise resolves to `"public"`. In a second test, click Cancel and assert the promise resolves to `null`. In a third, assert the default (no selection change) click on Publish resolves to `"secret"`.
- **No test for the `publish()` wiring itself.** `gist.ts` has zero existing automated coverage of any kind (confirmed — no `tests/**/*gist*` files exist anywhere in the repo today), consistent with CLAUDE.md's own note that Gist/GitHub-auth flows need a real OAuth app and are exercised manually rather than in the automated suite. This change doesn't alter that: the new `if (!doc.gistId) { ... }` branch is a two-line gate around an already-untested function, not a new testable surface on its own. Manual verification: publish a brand-new document, confirm the dialog appears and Cancel aborts with no network call (check DevTools), confirm choosing Public actually creates a public gist (check via `https://gist.github.com/<id>` while signed out, or the gist's own page showing no "Secret" label), then publish an update to the same document and confirm no dialog appears the second time.
