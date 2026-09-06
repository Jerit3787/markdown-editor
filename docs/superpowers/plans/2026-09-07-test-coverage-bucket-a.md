# Test Coverage — Bucket A (local-only remaining rows)

> Executed inline. One branch / one PR. No `wrangler dev`, no GitHub OAuth.

**Goal:** Close every remaining gap/partial row that can be tested against the plain `vite dev` server or in unit/component projects — the rows the earlier phases parked as "cross-ref §10/§12" or "needs a viewer role" but that don't actually need a live backend.

**Spec:** `docs/TEST-COVERAGE.md` (rows listed below).

## Global Constraints

- Test-only → one patch bump for the branch, `CHANGELOG.md` `### Changed`, no whats-new entry.
- Match existing patterns. Commit per logical group.
- If a row genuinely needs a live collaborator after all, move it to Bucket B and note it.

## Rows

| ID | Level | Approach |
|----|-------|----------|
| EDIT-17 | e2e (local) | Force `viewModeLocked` + hide `.view-selector`/`#toolbar`, switch docs, assert no pageerror |
| EDIT-25 | e2e (local) | `window.MDE.setReadOnly(true)` → typing is blocked; `setReadOnly(false)` → allowed |
| COLLAB-31 | unit | `collab.test.ts` — a redundant rejoin with the *same* session must not leave `identityUnverified` stuck |
| COLLAB-42 | component | `DocList.test.ts` — `$workspacePresence` entries render as `.presence-avatar` per doc row, capped at 3 |
| GIST-02 | unit | `gist.test.ts` — `updateGist` for a renamed doc sends `{ [oldFilename]: { filename: newFilename, content } }` (the GitHub rename shape), not a fresh key → no duplicate file |
| GIST-13 / REPO-24 | component + unit | MenuBar: Gist/repo items hidden or the signed-out variant shown when `$githubUsername` is null; `repo-doc-dates` / repo-commits client skip when signed out |
| SHELL-01 | e2e (local) | Command Palette: `Ctrl/Cmd+Shift+P` opens, type filters, ArrowDown+Enter runs, Esc closes |
| SHELL-02 | e2e (local) | Every `CommandPalette.svelte` entry is listed; `requires:"doc"` entries disappear with no active doc; each runs without a pageerror |
| SHELL-10 | e2e (local) | Fresh `mde:whatsNewSeen` → What's New auto-opens once → dismiss → reload → stays closed, `localStorage` bumped |
| SHELL-11 | component | `vi.mock` the entries module with a stale last-version, spy `console.warn`, import `WhatsNew.svelte` |
| MOB-11 | e2e (local) | Workspace switcher "Preview" badge stays within the sidebar's right edge on a narrow viewport |
| MOB-12 | e2e (local) | Share dialog "Anyone with the link" label not truncated on a 375px viewport |
| MOB-13 | e2e (local) | Mobile floating "exit Focus Mode" button appears in focus mode, exits it on tap |
| REPO-23 | component | DocInfoPanel shows the `repoLastSyncedAt` relative time when set |
| VER-19 | unit | `repo-sync.test.ts` — an image line pushed then pulled then re-serialized round-trips to byte-identical text (so `computeDiffRows` sees `same`) |

Deferred to Bucket B: **PREV-23** (suggestion marks in the preview) genuinely needs tracked suggestions on a shared doc.

## Tasks (one commit each)

- [ ] **Task 1 — unit:** COLLAB-31, GIST-02, VER-19, REPO-24 (client skip)
- [ ] **Task 2 — component:** COLLAB-42, SHELL-11, REPO-23, GIST-13 (MenuBar signed-out)
- [ ] **Task 3 — e2e local:** EDIT-17, EDIT-25, SHELL-01, SHELL-02, SHELL-10, MOB-11, MOB-12, MOB-13
- [ ] **Task 4:** catalog + version bump + CHANGELOG + PR
