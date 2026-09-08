# Transient mode announcement — design

**Status:** approved (brainstorm 2026-09-09)
**Roadmap:** `ROADMAP.md` → "Google Docs parity — features we don't have
yet" → "Persistent mode badge on the document" (the roadmap's "pinned
chip" wording was wrong — Google's indicator is transient; this spec
matches the real behaviour).
**Ships as:** one user-facing minor release (`1.55.0`).

## Goal

When a shared-workspace collaborator switches collab mode, or first
enters a shared workspace this session, a brief toast tells them which
mode they're now in:

- editing → **"You're now editing"**
- suggesting → **"You're now suggesting"**
- viewing → **"You're now viewing"**

It reuses the existing bottom-center toast stack (`stores/toast.ts` +
`Toast.svelte`). No new visual component.

## Why

The topbar `ModeSwitcher` is small and in a corner. A collaborator who
lands in Suggesting mode (their typing silently becomes tracked
suggestions) or Viewing mode has no prominent signal. Google Docs
flashes a momentary mode indicator over the document for exactly this;
this is the low-cost equivalent.

## Triggers

Both of these fire the toast:

1. **Mode switch.** `effectiveMode` (`stores/collabMode.ts`) changes to a
   new value while the active workspace `remoteId` stays the same.
2. **Workspace entry.** The active `remoteId` becomes one not seen since
   this page loaded → flash the current `effectiveMode` once, then mark
   that `remoteId` seen.

## Not triggered

- Plain local documents — `effectiveMode` is `null`.
- Leaving a workspace (`effectiveMode` → `null`).
- Switching between documents **within** a workspace already seen this
  session (the `remoteId` is unchanged and already marked seen).
- Re-entering a workspace already announced earlier this session (e.g.
  workspace A → B → A: A does not re-announce).

The "seen" set lives for the page's lifetime — it is **not** cleared by
`leaveCollabRoom` / `teardownWorkspace`. "Once per session" = once per
page load.

## Design

### New file: `client/src/mode-announce.ts`

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

// Pure core. Returns the Mode to announce, or null. Mutates `seen` when
// it counts a workspace entry (adds the new remoteId). `prev` is the
// last state this function was called with; `next` is the current one.
export function nextAnnouncement(prev: ModeState, next: ModeState, seen: Set<string>): Mode | null {
  if (!next.mode || !next.remoteId) return null;
  if (next.remoteId === prev.remoteId) {
    // same workspace — announce only a real mode change
    return next.mode !== prev.mode ? next.mode : null;
  }
  // workspace changed (or first-ever entry) — announce once per remoteId
  if (seen.has(next.remoteId)) return null;
  seen.add(next.remoteId);
  return next.mode;
}

let prev: ModeState = { remoteId: null, mode: null };
const seen = new Set<string>();
let lastToastId: number | null = null;

// Called once from collab.ts. Subscribing to effectiveMode is enough —
// it's a derived store that recomputes whenever collabRole or chosenMode
// change (enterCollabRoom sets collabRemoteId *before* collabRole, so
// get(collabRemoteId) here already reflects the new room), and it does
// NOT fire on a plain doc rebind (applyEditorMode is called directly for
// that, not through this subscription).
export function initModeAnnounce(): void {
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

### `stores/toast.ts` — `showToast` returns its id

```ts
export function showToast(message: string, type: ToastType = "info", duration = 3200): number {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type }]);
  setTimeout(() => dismissToast(id), duration);
  return id;
}
```

Existing callers ignore the return — no behaviour change. `mode-announce`
uses it to `dismissToast` the previous mode toast before showing the next
one, so rapid mode-toggling shows one mode toast at a time rather than
stacking three.

### `client/src/collab.ts` — wire it up

Add `import { initModeAnnounce } from "./mode-announce";` and call
`initModeAnnounce();` at module load, next to the existing
`effectiveMode.subscribe(...)` block (around line 279). Module-level, not
inside `init()` — same reasoning as that block's own comment (works
regardless of `DOMContentLoaded` timing; `showToast` just pushes to a
store).

## Non-goals / deferred

- **A dedicated on-document badge component** (top-center pill, mode
  icon, slide-in animation). The toast is the agreed v1; a Google-style
  document-surface indicator can be reconsidered later if the toast
  proves too easy to miss.
- **A mode icon in the toast.** `Toast.svelte` renders text only; adding
  an optional icon slot is out of scope.
- **Making the toast interactive** (click to open the mode switcher).
- **Syncing the announcement across collaborators** — it's a purely
  local, per-session reminder.
- **Announcing on a plain local document** — there is no mode there.

## Global constraints

- Two `tsconfig.json`s, checked separately. `mode-announce.ts` lives
  under `client/src/` and imports only client modules — it falls under
  `client/tsconfig.json` (relaxed), but write it clean anyway.
- `npm run format` (Prettier) and `npm run typecheck` must pass.
- User-facing → **minor** bump to `1.55.0`: `package.json` + both
  `package-lock.json` `"version"` fields; a `## [1.55.0] - <date>`
  CHANGELOG section (`### Added`); a `whats-new-entries.ts` entry with a
  real committed screenshot at `client/public/whats-new/mode-announce.png`
  (`whats-new-entries.test.ts` fails if it's missing).
- `docs/TEST-COVERAGE.md` gets a row.

## Testing

### Unit — `tests/client/src/mode-announce.test.ts`

Drives `nextAnnouncement(prev, next, seen)` directly (a fresh `Set` per
case):

| Case | prev | next | seen | expect |
|---|---|---|---|---|
| plain local doc | `{null,null}` | `{null,null}` | `∅` | `null` |
| first entry to a workspace | `{null,null}` | `{"w1","viewing"}` | `∅` | `"viewing"`, and `seen` now has `w1` |
| switch mode, same workspace | `{"w1","viewing"}` | `{"w1","suggesting"}` | `{w1}` | `"suggesting"` |
| same mode, new doc, seen workspace | `{"w1","viewing"}` | `{"w1","viewing"}` | `{w1}` | `null` |
| re-enter a seen workspace | `{null,null}` | `{"w1","viewing"}` | `{w1}` | `null` |
| leave a workspace | `{"w1","viewing"}` | `{null,null}` | `{w1}` | `null` |
| switch to a different workspace, unseen | `{"w1","editing"}` | `{"w2","viewing"}` | `{w1}` | `"viewing"`, `seen` now has `w2` |

Plus one assertion that `MODE_ANNOUNCE_COPY` has all three modes with the
exact agreed strings.

### Unit — `tests/client/src/stores/toast.test.ts`

Add: `showToast` returns a positive integer id that `dismissToast`
accepts (the toast is gone afterwards).

### e2e — `tests/e2e/collab/mode-switcher.spec.ts`

Add to the existing "a collaborator switches Editing → Viewing" test: after
switching to Viewing, `expect(page.locator('.toast', { hasText: "You're now viewing" }))`
is visible; after switching back to Editing, `"You're now editing"`
appears.

## Implementation order (one commit each, TDD)

1. `stores/toast.ts` — `showToast` returns its id + the toast-store test.
2. `mode-announce.ts` — `nextAnnouncement` + `MODE_ANNOUNCE_COPY` +
   `initModeAnnounce`, unit tests, wired into `collab.ts`; the e2e
   assertion.
3. Release — version, CHANGELOG, What's New entry + screenshot capture
   script + committed screenshot, TEST-COVERAGE row, ROADMAP note.
