# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/).

## [1.44.0] - 2026-09-05

### Added

- **A document created in a shared workspace now reaches every already-connected collaborator immediately, not just those who join afterward.** Previously, a document created (or first switched to) after a collaborator's connection was already established never appeared in their document list — no reload or rejoin fixed it short of leaving and re-joining the workspace entirely.
- **A shared workspace that can no longer be reached — an expired session, a revoked invite, or a share link nobody granted you access to — now says so clearly instead of silently dropping you into a disconnected, fully-editable local copy.** The editor locks to read-only Preview with a banner explaining why, and a Sign-in button when signing in again could restore access.

### Fixed

- **A shared document's content could double itself every time its page was refreshed, growing without bound.** Reopening or reloading a page showing an already-synced shared document raced the collaborative editor's attachment against the server's own sync handshake: the server's content, once it arrived, could get inserted into a CodeMirror view that already showed that same content locally, appending a second copy each time. Also fixed a related case where a collaborator joining a shared workspace for the very first time could see a stale initial snapshot instead of the room's live content.
- **A signed-out visitor (or one whose GitHub session quietly expired) still fired a doomed request against a private repo's commit history** every time a repo-linked document's dates or version history were checked, 401ing with nothing useful to show for it. Both call sites now skip the request outright when there's no session at all.

## [1.43.0] - 2026-09-05

### Added

- **A small status bar indicator now appears when your access to a shared workspace can't actually be verified** — e.g. your GitHub session quietly expired while you were the owner or an invited collaborator. Previously you'd just silently end up with whatever role the link's general access grants (often Preview-only), with nothing telling you why. Click the "Signed out" indicator to sign in again and restore your real access.

### Changed

- **`WorkspaceRoom` and `CollabRoom`'s identical role-resolution logic is now one shared function** (`src/access-role.ts`'s `resolveRole()`) instead of two copy-pasted copies — no behavior change, just one place to read and update it going forward.

### Fixed

- **A document's metadata (Title, Author, etc. — set via the Doc Info/Edit panel) showed up as ugly, fully visible plain text at the top of a published Gist, pushed repo file, or exported `.md`.** The serialized block is now wrapped in an HTML comment, which every CommonMark/GFM renderer (GitHub Gist, GitHub's own repo file viewer) already treats as invisible — it stays fully visible and editable in the raw `.md` source, just hidden from rendered views. Metadata already published under the old bare format is still read back correctly when reopened. A metadata field containing the literal sequence `-->` or `--!>` (both recognized by HTML's comment-parsing rules as closing sequences) is escaped so it can't break out of the wrapping comment early.
- **Command palette rows (Ctrl/Cmd+Shift+P) had no left/right padding — labels sat flush against the left edge and category badges flush against the right.** Each row carries both `.command-palette-row` (its own `padding: 8px 10px`) and `.shortcuts-row` (reused for its label/badge layout, but whose own `padding: 6px 0` is meant for the already-padded Keyboard Shortcuts modal) — both single-class selectors, so plain import order in `style.scss` decided the winner. A combined `.command-palette-row.shortcuts-row` selector now restores the intended horizontal padding regardless of import order.
- **Switching documents while viewing a shared workspace in a locked view mode (Preview-only viewer access, or Suggestion-mode) could silently break the whole toolbar.** `updateMainView()` runs on every document switch and unconditionally set `.style.display` on `.view-selector` — an element Toolbar.svelte only renders while view mode isn't locked. With it absent, the very next switch threw an uncaught exception straight out of that update, aborting it (and anything else queued in the same reactive pass) partway through, which is what actually made the toolbar disappear. That element's style is now only touched when it actually exists.

## [1.42.4] - 2026-09-05

### Fixed

- **A document that merely mentioned this app's own image-embed syntax as a documentation example (e.g. explaining that a pasted image looks like `![alt](data:image/png;base64,...)` in prose) had that example treated as a real image on Gist publish.** `gist.ts`'s image-push regex accepted any trailing text after `;base64,` as "content", so a literal `...` placeholder was extracted and sent to the server as if it were real image data — a real request the server correctly rejected, surfacing as "Gist published, but pushing images failed: Invalid base64 content..." (the exact bug the previous release's diagnostic-detail fix let this be seen for the first time). The regex now requires the actual base64 alphabet for that group, matching the stricter check already used when opening a gist — a non-match is now correctly skipped like any other non-image markdown link, with no request sent at all.

## [1.42.3] - 2026-09-04

### Fixed

- **A failed Gist action always showed a useless "HTTP 400"/"HTTP 404" toast instead of the server's actual reason.** `gist.ts`'s shared `errorMessage()` helper only handled GitHub's own JSON-shaped proxy errors (`{"message": "..."}`) — this app's own validation errors (e.g. the Gist image-upload endpoint's 400s) are plain text, and `res.json()` throws on those, silently collapsing every one of them to a bare HTTP status with no indication of what actually went wrong. This is why an image-push failure's toast read "Gist published, but pushing images failed: HTTP 400" instead of a specific reason. `errorMessage()` now reads the body as text first and falls back to it whenever the response isn't JSON (or has no `message` field), so a validation error's real text reaches the toast.
- **A pulled image asset's data URL used a fake `image/*` MIME type instead of the real one.** `repo-sync.ts`'s pull path built `data:image/*;base64,...` for every image asset fetched from a linked repo — `image/*` is a valid `Accept`-header wildcard but not a real MIME type, so it silently failed the regex Gist publish uses to recognize an image data URL. A document with an image round-tripped through repo-sync would fail to include that image when later published to a Gist, with no error — the image reference was simply dropped from the push. The pulled asset's actual file extension is now used to build a real `image/<subtype>` MIME type.

### Changed

- **The Gist image-upload endpoint's error responses now include diagnostic detail** (payload length/prefix, which field was missing or malformed) instead of a bare one-line message — this is what finally surfaced the `errorMessage()` bug above once its own fix let that detail reach the toast.

## [1.42.2] - 2026-09-04

### Fixed

- **Publishing or updating a Gist could fail with a confusing "not-found" error.** The GitHub sign-in flow requested only the `repo` OAuth scope, which silently replaced the previously-granted `gist` scope for anyone who (re)authorized after that change — GitHub scopes aren't additive across separate authorize requests. Sign-in now requests both `repo` and `gist` together, and Gist publish now checks for the `gist` scope up front, prompting for a fresh sign-in with a clear explanation instead of surfacing GitHub's opaque 404.

## [1.42.1] - 2026-09-03

### Fixed

- **A test-only GitHub API fetch mock now checks the parsed host instead of a string prefix.** `tests/src/github-repo.test.ts`'s fake-GitHub-server harness redirected requests via `url.startsWith("https://api.github.com")`, which a URL like `https://api.github.com.evil.example/...` would also satisfy — flagged by CodeQL as an incomplete URL substring sanitization. No production code was affected (the check only exists in test infrastructure, redirecting URLs this test suite itself constructs), but the check now parses the URL and compares its `host` exactly.

## [1.42.0] - 2026-09-02

### Added

- **Wikilink rename cascade.** Renaming a document now automatically rewrites every `[[OldName]]` reference to it elsewhere — in local documents, in the document itself if it self-references its own old name, and in any shared workspace's documents (even one you aren't currently connected to) via a new authenticated endpoint that patches that workspace's live content directly. A brief toast reports how many links were updated; nothing appears when there was nothing to fix. A document in a shared workspace you don't have editor access to is silently left as-is, same as before this feature.

## [1.41.2] - 2026-09-02

### Security

- **GitHub repo endpoints now validate every caller-supplied value before it reaches a GitHub API URL or a git tree entry.** The Worker holds the user's `repo`-scoped token and never hands it to the client, so `/api/repo/*` is the only way to spend it — but owner, repo, branch, commit/tree shas, and the `contents/` path were interpolated straight into the upstream URL, and push blob/delete paths went into the tree entries unchecked. A dot segment surviving into any of those turns a narrow endpoint into a general-purpose authenticated API proxy (per-segment `encodeURIComponent` does not help: `.` is unreserved, so `..` and `%2e%2e` alike are still resolved as dot segments by the URL parser after interpolation). Each value is now checked against what it can legitimately be, and the request is refused with a 400 before any fetch goes out.
- **The access endpoint no longer discloses a workspace's owner and invite roster to people who have no access to it.** `GET .../access` stays readable without authorization on purpose — the join flow needs `generalAccess` and the link role before a visitor has any access at all — but the roster was never part of that decision. Owner and invited list are now blanked for a requester who does not authorize into the room; participants see them unchanged. Applies to both `WorkspaceRoom` and the legacy `CollabRoom`.
- **Sessions now carry a server-enforced expiry.** The session cookie is a bearer credential, and only the browser's `Max-Age` bounded it — a copied value stayed valid until `SESSION_SECRET` was rotated. The 30-day lifetime is now stamped inside the encrypted payload and enforced on every request. **One-time effect: existing sign-ins are invalidated, so you'll be asked to sign in to GitHub again once.**
- **The GitHub sign-in popup escapes its result payload before inlining it.** The popup page inlines a `postMessage` payload into a `<script>` block on the app's own origin; `JSON.stringify` escapes quotes but not `<`, so an upstream error message containing `</script>` would have closed the block early and landed as live markup.
- **Mermaid and KaTeX rendering pin their sanitization settings explicitly.** Both render collaborator-supplied source into the preview _after_ its DOMPurify pass, not through it — `securityLevel: "strict"` and `trust: false` are each library's own default, but pinning them means a future version changing that default can't silently turn it off.

## [1.41.1] - 2026-09-01

### Fixed

- **Share dialog's "Anyone with the link" label truncated on mobile Safari.** The width reserved for the native dropdown's arrow was tuned against desktop Chromium's narrower arrow chrome and clipped the label on an iPhone; widened the buffer and added a text-overflow ellipsis as a fallback.
- **The View menu dropdown could overflow off the right edge of the screen on mobile.** Every menu-bar dropdown used to hardcode which single item anchored to the right instead of the left, so it broke again the moment a different menu's dropdown grew wide enough to overflow — now each dropdown measures itself against the viewport when it opens and flips anchor side only if it would actually overflow.
- **The workspace switcher's "Preview" badge could push past the sidebar's edge.** The Svelte-mounted wrapper around the switcher had no `display: contents`, unlike every other mount point in the app, so its flex-shrink/ellipsis styling was never actually reachable — the row just grew to its full, un-truncated width instead of shrinking to fit.

## [1.41.0] - 2026-09-01

### Added

- **Shared-workspace previews.** Opening a share link when you already have your own workspaces now previews it instead of permanently adding it to your sidebar — a "Preview" badge shows in the workspace switcher, with a "Keep this workspace" action if you decide to hang onto it. Closing or reloading the tab drops an unpicked preview; revisiting the link starts a fresh one. A brand-new visitor with no workspaces of their own still lands directly in the shared workspace, same as before. The "Join shared workspace" dialog (shown for a multi-document share when you have workspaces to merge into) also gains a "Preview only" option alongside "Merge in" and "Add as new workspace".

## [1.40.5] - 2026-09-01

### Fixed

- **Flaky `mobile-scroll-sync.spec.ts` echo-guard test** ("a scroll echo arriving long after the write triggers no redundant write attempt"). Root cause: the test relied on a real browser `scrollTop` write's native "scroll" echo staying deferred long enough for the test's own synthetic late-echo dispatch to be first — but in headless Chromium that native echo reliably arrives within ~150-200ms, consuming the app's echo guard before the test's simulation ever ran, making the guard (working exactly as designed) look broken. The test now swallows that real echo with a capturing listener (which runs before the app's own non-capturing listener on the same target, regardless of registration order) until it's ready to fire its own deterministic "long-delayed echo" simulation. No production code changed — the guard itself was already correct.

## [1.40.4] - 2026-09-01

### Fixed

- **Noisy "http proxy error: /api/auth/github/me" / `ECONNREFUSED` output from every local dev-server-only test run.** `client/vite.config.ts`'s `/api` proxy always targets `127.0.0.1:8787`, but neither `dev:client` nor Playwright's local e2e project ever run `wrangler dev` alongside it, so every auth-check request was a doomed connection Vite logged to stderr — even though the client already handles the failure gracefully. The proxy now bypasses straight to a quiet 404 when `VITE_DISABLE_API_PROXY` is set (set by `playwright.config.ts`'s local webServer); a real two-terminal `vite dev` + `wrangler dev` workflow is unaffected.

## [1.40.3] - 2026-09-01

### Changed

- **Toolbar grouping.** The trailing cluster of insert-type buttons (Link, Image, Manage images, Table, Horizontal rule, Insert diagram, Math, Footnote, Command Palette) was one long run with no separators. Now grouped by type — media/reference insert, structural insert, notation insert — with Command Palette set apart at the end since it isn't a content-insertion command.

## [1.40.2] - 2026-09-01

### Fixed

- **The What's New category icons rendered at ~13px instead of the intended 32px.** `.icon`'s own `width/height: 1em` and the new `.whats-new-category-icon` rule had equal CSS specificity, so source order in the compiled stylesheet — not the more specific-looking rule — decided which one won.

## [1.40.1] - 2026-09-01

### Changed

- Each category card in the What's New index (Help menu's manual reopen) now shows an icon alongside its name and count.

## [1.40.0] - 2026-09-01

### Added

- **Categorized What's New.** Reopening What's New from the Help menu now starts at a category index instead of a 27-entry stepper beginning at the very first release. Pick a category to step through just its updates; "Done" returns to the index instead of closing the whole modal. The automatic popup for missed updates on load is unchanged.

## [1.39.1] - 2026-08-31

### Fixed

- **The Preview pane didn't refresh for a pending suggestion, or for an editor's accept/reject of one.** A delete suggestion is deliberately blocked from ever touching the document's text (the text stays until an editor resolves it), and accepting an insert or rejecting a delete drops the suggestion without touching the text either — so CodeMirror's own change event, the only thing that previously triggered a Preview refresh, never fired for any of those three cases. Preview now also refreshes whenever the suggestions themselves change, not just the document text.
- **The "Suggestion-Mode Collaboration" What's New entry was missing its screenshot.**

## [1.39.0] - 2026-08-31

### Added

- **Suggestion-mode collaboration.** The reviewer role now proposes edits instead of being read-only: insertions and deletions show up as tracked, per-suggestion changes (underlined additions, struck-through deletions) that the document's editor can accept or reject, or the reviewer can withdraw. Viewer role now shows Preview only, with no edit surface at all.

## [1.38.5] - 2026-08-30

### Fixed

- **Hardened split-view scroll-sync against a wider version of the "drifts back on its own" bug than 1.38.4 fixed.** That release fixed one specific case (scrolling to the very end of a document); further reports showed the same symptom after aggressive fling-scrolling in general, settling at an unpredictable position. The guard that stops scroll-sync's own mirrored write from being treated as a fresh user scroll only tolerated that mirrored "echo" event arriving within about one animation frame — on a real device, writing a pane's scroll position while the user is actively touch-scrolling it can be silently deferred by the browser until the gesture ends, arriving well past that window. The guard now recognizes its own echo by comparing the incoming value against what it last wrote, rather than a timing window, so it holds regardless of how long the echo is delayed.

## [1.38.4] - 2026-08-30

### Fixed

- **Split view could scroll itself back away from where you'd scrolled to, with no touch input, after reaching the end of a document.** When the preview pane reached its own bottom, scroll-sync moved the editor to its end via a CodeMirror `scrollIntoView` effect instead of a plain scroll position write like every other edge case in this function — that effect resolves asynchronously (confirmed live: the editor's scroll position didn't move until a later animation frame) and doesn't reliably land at the editor's exact maximum scroll position. On a real device this could land the editor just outside the small tolerance its own "already at the end" check uses, so a follow-up scroll event fell through to normal interpolation and pulled both panes back toward the middle of the document. The editor now jumps to its end with the same plain, synchronous write its "editor at its own bottom" counterpart already used.

## [1.38.3] - 2026-08-30

### Fixed

- **The Help menu overflowed off the right edge of the screen on mobile, clipping its items.** Every menu bar dropdown (File/Edit/Format/Insert/View/Help) was anchored to its trigger's left edge, correct for the ones near the left of the bar, but Help is the last/rightmost item — left-anchoring it pushed the dropdown past the right edge of a narrow viewport instead. Help now anchors to its trigger's right edge like Share/Settings do, extending leftward.

## [1.38.2] - 2026-08-30

### Fixed

- **The preview pane could still snap back to an unrelated position on mobile, and split view no longer scrolled the two panes together.** 1.38.1 worked around this by disabling split view's scroll-sync entirely on mobile, but that also removed the desired "scroll one pane, the other follows" behavior — and it turned out not to be scroll-sync's fault in the first place. The actual cause was a separate mechanism (`followCursorInPreview`) that re-centers the preview on the cursor's position on every cursor/selection change, not just scroll events; on mobile's shorter, stacked panes its "already visible" check is far more likely to fail, and a fast scroll-then-release touch gesture commonly registers as a tap that moves the cursor — snapping the preview to wherever the cursor last was, discarding wherever the user had actually scrolled to. Scroll-sync itself is restored on mobile (it was never actually the problem); the cursor-follow behavior is now scoped to the side-by-side desktop layout only, where "the preview follows what you're typing" makes sense in a way it doesn't on mobile's stacked layout.

## [1.38.1] - 2026-08-30

### Fixed

- **Styled text fields (Link, Share, Custom CSS, the new Document Info edit fields, and others) still triggered iOS Safari's zoom-on-focus on narrow viewports.** The app has a global rule forcing every text field to at least 16px on mobile specifically to prevent this, but any component that set its own smaller font-size on a class selector silently outranked it by CSS specificity. The mobile rule now uses `!important` so it holds as the intended hard floor regardless of what any individual component declares.
- **Scrolling could unexpectedly jump a pane back to the top on mobile.** Split view's scroll-sync mirrors one pane's position onto the other, correct when they sit side by side on desktop, but on a narrow viewport split mode stacks them vertically as two independently-scrollable sections instead — scrolling one pane near its own top silently reset the other, already-scrolled pane back to the top. Scroll-sync is now scoped to the side-by-side desktop layout only.

## [1.38.0] - 2026-08-30

### Added

- **Document Info edit modal.** Document Info is now a read-only summary — including a new Name row — with an Edit button that opens a dedicated modal for renaming the document and editing its metadata and citation settings.

### Fixed

- **Comment reply field and comment draft box rendered as a plain white box in dark mode.** Both had a border but no explicit background/text color, so they fell back to the browser's default light input styling instead of matching the theme.

## [1.37.0] - 2026-08-29

### Added

- **Citations & bibliography.** `[@key]` (or `[#key]`, per a new per-document marker-style setting) resolves against a bibliography and renders as a numbered link or an inline `(Author, Year)` — both configurable per document from a new Citations section in Document Info, alongside a choice between typing reference definitions directly in the document (like footnotes) or managing them as structured entries in the panel. Structured entries round-trip as real reference-definition text on `.md` export, Gist publish, and repo push. The Markdown Compatibility Checker now flags citations as flavor-specific.
- **Split Format and Insert out of the Edit menu.** Bold/Italic/Strikethrough now live in a new Format menu, and Insert Link/Insert Image/Manage Images now live in a new Insert menu, instead of all being crowded into Edit alongside Undo/Redo/Find/Cut/Copy/Paste. No commands, shortcuts, or behavior changed — only where they live in the menu bar.
- **Smart version-history grouping.** History now captures every 30 seconds instead of every 5 minutes, and Version History groups continuous edits into collapsible sessions (e.g. "Today, 2:00–2:45 PM · 12 edits") instead of a flat list — a real gap of 30+ minutes starts a new session, and an older session's in-between snapshots collapse down to its final state once it closes, keeping storage bounded. The Diff view can now compare any two selected historical entries against each other, not just a version against the live document.

## [1.36.0] - 2026-08-28

### Added

- **MultiMarkdown syntax support: definition lists, superscript/subscript, and document metadata.** `Term` / `:   Definition` now renders as a real definition list; `2^10^` and `H~2~O` render as superscript/subscript. A new Metadata section in Document Info lets you add freeform `Key: Value` fields to a document — they round-trip as a real MultiMarkdown metadata block on `.md` export, Gist publish, and repo push, and are parsed back out automatically when opening a file that already has one. The Markdown Compatibility Checker now flags definition lists, superscript, and subscript as flavor-specific.

## [1.35.3] - 2026-08-28

### Fixed

- **The comment-draft popup could render partly off-screen on a narrow phone viewport.** It positioned itself using the selection's raw screen coordinate with no clamping against the viewport edge, so a selection near the right (or bottom) edge pushed the popup — up to 240px wide once expanded — partly out of view.
- **Selecting different text while the comment-draft box was still open no longer collapsed it back to the plain "Add comment" button.** The box's expanded/collapsed state didn't reset when the underlying selection changed, so re-selecting text elsewhere just re-anchored the already-expanded box at the new location instead of prompting fresh for the new selection.

## [1.35.2] - 2026-08-28

### Fixed

- **There was no way to add a comment from a mobile device.** The floating "Add comment" button only ever rendered while the Comments panel was open, but on mobile the panel is a bottom sheet whose backdrop blocks touch on the whole editor while open — so selecting text (required to comment) was only possible with the panel closed, and the button that appears once you have a selection only showed with the panel open. The button no longer requires the panel to already be open.
- **The page still zoomed in on focusing the editor on mobile**, despite an existing mobile CSS rule meant to prevent it. `EditorView.theme()` sets `.cm-content`'s font-size directly, compiled against a CodeMirror-generated unique class that always out-specifies a plain page-CSS rule targeting the bare `.cm-content` selector — so that rule silently never took effect. The mobile-width override now lives inside the theme itself instead, where it can actually win.

## [1.35.1] - 2026-08-28

### Changed

- The Markdown compatibility checker's category labels now use a small "(i)" hint icon (same click-to-reveal interaction as other hints in the app) instead of inline parenthetical explanation text.

## [1.35.0] - 2026-08-28

### Added

- **Markdown compatibility checker.** The Document Info panel now has a "Compatibility" row that flags markdown constructs which won't render the same elsewhere — wikilinks, image/diagram references (app-only, won't render at all outside this editor), and GFM/KaTeX extensions like tables, strikethrough, task lists, math, and footnotes (flavor-specific, fine here and on GitHub, not guaranteed on a stricter renderer). Click any flagged item to jump straight to it in the editor.

## [1.34.0] - 2026-08-28

### Added

- **Choose a Gist's visibility when first publishing it.** Publishing a document to Gist for the first time now asks Secret (default, matches previous behavior) or Public before creating it — GitHub's API only accepts this choice at creation time and never lets it be changed afterward, so later "Update Gist" actions on the same document are unaffected and show no prompt.

## [1.33.0] - 2026-08-28

### Added

- **Printing support.** A new Print action (File menu, next to Export, and the Command Palette) opens the browser's native print dialog. A dedicated print stylesheet hides all app chrome — sidebar, toolbar, editor pane, comments panel, status bar — so only the rendered document prints, titled with the document's name, with sensible page-break behavior around headings, images, code blocks, and tables. Works identically via the browser's own Ctrl/Cmd+P shortcut, since the print stylesheet applies regardless of how printing was triggered.

## [1.32.0] - 2026-08-28

### Added

- **Insert an existing image, or replace one in place.** The toolbar's Insert image button now opens the Images modal — click any thumbnail to insert a reference to it, or use the new "Upload new image" button for the original upload flow. Each image also gets a new Replace action: pick a new file and it overwrites that image everywhere it's referenced, without touching the document text or its position.

## [1.31.0] - 2026-08-28

### Added

- **Undo/Redo and Command Palette toolbar buttons.** Undo and Redo now sit at the start of the formatting toolbar (always visible, never collapsed into the "⋮" overflow menu), and a Command Palette quick-access icon sits at the end — all three were previously reachable only via keyboard shortcut or the Edit/Help menus.

## [1.30.1] - 2026-08-28

### Fixed

- **The toolbar's "more formatting options" (⋮) overflow menu stacked every button one per line** instead of wrapping them into a compact grid. `.toolbar-overflow-menu.open`'s `display: flex` and the generic `.dropdown-menu.open`'s `display: block` (both two classes) tied in specificity, so whichever loaded later in the compiled stylesheet won — which happened to be the generic block-list rule, silently defeating the overflow menu's intended wrapped-grid layout.

## [1.30.0] - 2026-08-28

### Added

- **Unresolved-comment count badge.** The Comments topbar icon and File menu entry now show a live count of unresolved comment threads on a shared document, so you can tell there's outstanding feedback without opening the panel first. Reflects the currently open document only; local (never-shared) documents have no resolved/unresolved concept, so nothing shows for them.

## [1.29.2] - 2026-08-28

### Fixed

- **The mobile toolbar row's height visibly shifted by a few pixels when switching between Editor, Split, and Preview view modes.** `.view-selector` (the editor/preview toggle icons) never set an explicit icon size, unlike `#toolbar`'s own icons — its icons fell back to the browser's default `<button>` font-size instead of a deliberate value, making them a couple pixels shorter. Since both rows share one flex parent that stretches to the taller side, hiding `#toolbar`'s buttons in Preview-only mode let `.view-selector`'s slightly-shorter natural height take over, shrinking the whole row. Matching `#toolbar`'s explicit icon size fixes both the mismatch and the mode-dependent shift.

## [1.29.1] - 2026-08-28

### Fixed

- **The mobile Comments and sidebar bottom sheets rendered dimmed themselves**, not just the page behind them — a regression from v1.28.1's top bar dimming fix. That fix raised the backdrop above the top bar, but the backdrop and the sheet are sibling elements (unlike the desktop modal pattern it was modeled on, where the modal content is a child of its backdrop and always paints above it regardless of z-index), so the backdrop ended up painting over the sheet too. The sheets now render above their own backdrop again.
- **The mobile view-mode selector buttons (top-right of the toolbar) were noticeably smaller than every other toolbar button.** The mobile touch-target sizing rule targets `#toolbar button` specifically, but the view-selector is architecturally a separate flex row sitting outside `#toolbar` — so it never picked up the bump and stayed at its desktop size.

### Changed

- Internal: added Playwright regression coverage for both fixes above, plus v1.28.1's original top bar dimming and mobile button-sizing/share-button-shape fixes, asserting on actual click-target and bounding-box behavior so a future refactor of the underlying z-index/sizing values can't silently reintroduce any of them. No user-facing change.

## [1.29.0] - 2026-08-27

### Added

- **Search and replace.** Ctrl/Cmd+F opens a find bar over the current document with a live match count and case-sensitive/whole-word/regex toggles; Ctrl/Cmd+H expands it with a Replace row (Replace and Replace All). Operates on the currently-open document only.

## [1.28.1] - 2026-08-27

### Fixed

- **Mobile bottom sheets (Comments, sidebar) left the top bar undimmed and still clickable underneath the backdrop.** The backdrop's `z-index` sat below the top bar's, so its buttons and dropdowns stayed visually undimmed and interactive while a sheet was supposedly blocking the rest of the page.
- **The sidebar/hamburger toggle button was a different, smaller size than every other toolbar button on mobile.** A CSS specificity mismatch let the desktop-sized rule win over the mobile touch-target rule for that one button.
- **The mobile Share button rendered as an oval instead of a circle.** With the two-button desktop pill collapsed to a single icon on mobile, the button group's leftover fixed height stretched the button taller than it was wide, so its round corners no longer formed a true circle.

## [1.28.0] - 2026-08-27

### Added

- **Shared document names now sync to every collaborator.** Renaming a shared document previously only changed the title on your own browser — everyone else kept seeing the old name until they happened to reload. The name now travels over the same live connection as the document's content and images (and is gated the same way: only an editor's rename reaches collaborators), so a rename shows up for everyone immediately, including on a fresh join.

## [1.27.2] - 2026-08-19

### Fixed

- **Opening a shared workspace link for the first time landed on the empty homepage instead of the shared document.** The app's own routing logic was clearing the share link's URL before the code that actually joins the shared workspace ever got a chance to see it — this broke every direct visit to a `/w/...` share link, not just first-time visitors.

### Changed

- Internal: the editor's core logic — CodeMirror setup, formatting commands, comment/image markers, slash commands, wikilink autocomplete, the live preview pane, and view-mode toggling — has fully moved out of one large `app.ts` into focused Svelte components and stores. No user-facing behavior change.
- Added a real Playwright end-to-end test suite (`npm run test:e2e`), covering formatting, view modes, keybindings, focus mode, images, comments, slash/wikilink commands, live preview rendering, export, and — for the first time — live collaboration itself (real-time sync, read-only viewer access, undo/redo inside a shared room). Manual/on-demand only, not part of CI.

## [1.27.1] - 2026-08-19

### Changed

- Dependency updates (Renovate): `@types/node` to v24.13.3 (major bump, package.json range updated), `@cloudflare/workers-types` to 5.20260818.1, `wrangler` to 4.124.0, `vitest` to 4.1.11, `marked` to 18.0.10, `isomorphic-git` to 1.41.5, `y-codemirror.next` to 0.3.6 (all within their existing package.json ranges, lockfile only). This release syncs the local lockfile with what's already merged to master.

## [1.27.0] - 2026-08-19

### Added

- **Local version history and personal notes on a repo-linked document now travel with the repo**, instead of being stuck on whichever device created them. Pushing bundles a doc's local snapshots and notes into the same commit as its content; opening Version History or the comments panel on another device pulls them in automatically and merges them with whatever's already there.

### Fixed

- **Selecting an older commit in Version History's Diff tab could show every line as newly added**, with nothing on the "before" side, while the content was still loading — or permanently, if the fetch failed. The Diff tab now shows a loading state instead, matching the Preview tab.
- **A file renamed in the repo showed a broken diff (or a "couldn't load" error) for any commit from before the rename**, since the commit's content was looked up at the file's current path, which didn't exist yet at that point in its history. Falls back to searching that commit's own tree for the file under its old name.

## [1.26.1] - 2026-08-19

### Fixed

- **Text pulled from a GitHub commit could show up as mojibake** (em dashes, curly quotes, and accented letters turned into garbled characters) in Version History's Diff tab and anywhere else repo file content is decoded. Base64 content from GitHub's API is UTF-8, not Latin-1 — it's decoded as such now, so the corruption no longer compounds on repeated pull/push cycles either.
- **A repo-linked document's Version History Preview tab showed a broken-image icon** for images that render fine everywhere else. The preview now resolves images against the selected version's own image map instead of the live document's, which never matched a repo commit's `assets/...`-style paths.

## [1.26.0] - 2026-08-18

### Added

- **The diff view now looks like GitHub's.** Line numbers on both sides, word-level highlighting for exactly what changed within a line (not the whole line), and a Split/Unified toggle to switch between side-by-side and stacked layouts.
- **Images now render in diffs instead of showing as raw text.** A line that's just an image reference shows a before/after thumbnail comparison — for local documents, shared documents, and repo commits alike — with per-snapshot accuracy (an old version shows the image it actually had, even if it's since been replaced) and restoring a version brings its images back too.

### Fixed

- **Deleting or renaming a document in a repo-linked workspace now propagates to the repo on the next push.** Previously push only ever created or updated files — a deleted or renamed local document left an orphaned or stale file behind in the repo.
- **Pulling from a repo no longer produces a phantom diff on every re-pull of an unchanged image.** Image references were re-keyed with a fresh timestamp on every pull even when the image itself was byte-identical; the key is now derived from the image's own path, so it round-trips correctly.
- **Rapid document switching in a shared workspace could leave duplicate "who's viewing this" avatars** that lingered until the connection was evicted. Switching now cancels an in-flight join instead of letting two connections race.

## [1.25.0] - 2026-08-18

### Added

- **Each tab now has its own document.** The URL reflects whichever document is open — deep links work, and switching documents updates the URL so browser back/forward moves between them. Sidebar rows are real links too: Ctrl/Cmd-click (or middle-click) a document to open it in a genuine new tab, Google-Docs style.
- **Document Info shows a repo-linked document's real commit history** for Created/Edited, instead of local-only timestamps that reset to "just now" every time you pull an existing repo.
- **Receiving a single shared document always lands it as its own new workspace**, named after the document, with no modal to click through — for every receiver, not just someone with no workspaces yet.

### Fixed

- **Opening this app in more than one tab could silently destroy unrelated documents or workspaces.** Every save now merges with whatever's actually in local storage instead of blindly overwriting it with a possibly-stale copy.
- **The comments panel left a permanent strip of dead space beside the editor whenever it was collapsed** (most of the time) — the editor and preview now genuinely fill the full width, and the panel's open/close motion is smooth again.

## [1.24.1] - 2026-08-18

### Fixed

- **Mobile's document sidebar (the bottom sheet) slides open/closed again
  instead of snapping instantly.** An unscoped desktop-only transition
  rule was winning a CSS specificity tie against the mobile-specific one,
  silently animating a property mobile never changes.
- **The editor/preview view-selector icons no longer squash against the
  edge when the comments panel is collapsed.** They share a grid column
  with the comments panel, which now reserves a minimum width instead of
  shrinking to zero.

## [1.24.0] - 2026-08-18

### Added

- **Version History now includes the linked repo's commits, not just
  local snapshots.** Open File > Version History on a repo-linked
  document and its commits (that touched that file) appear interleaved
  with local snapshots in one chronological list, each tagged with a
  small GitHub icon.
- **Diff any version against the current document**, local snapshot or
  repo commit alike — a "Preview | Diff" toggle in Version History
  switches between the existing rendered preview and a side-by-side
  diff, with a replaced line's old and new text paired on one row.
- **Restore from a repo commit**, on both local-only and
  shared/collaborative documents — restoring is itself always undoable,
  same guarantee local-snapshot restore already had.
- **Actions that need a workspace or an open document to do anything now
  say so upfront.** New document, GitHub Repo (link/browse), Publish,
  and Export all disable with the rest of their already-gated siblings
  instead of staying clickable and erroring after the fact; the Command
  Palette hides commands that don't apply to the current state instead
  of listing them non-functionally.
- **Shared workspaces sync every open document's live edits**, not just
  whichever one happens to be active.
- **Linking a workspace to an existing repo preserves files by name**
  instead of duplicating them into renamed copies, surfaces push
  conflicts instead of silently discarding them, and pushes a real first
  commit instead of an auto-init placeholder.
- **Mermaid diagrams and filenames survive a repo push intact.** Diagrams
  resolve to their real source before pushing instead of a bare
  reference, and filenames keep their original case and spacing instead
  of being forced to lowercase-with-hyphens.
- **Linking to a repo renames a still-default-named workspace to match
  it**, dismisses the repo picker modal immediately instead of after the
  whole sync finishes, and the GitHub Repo submenu shows time since the
  last sync.
- **The empty "No workspace yet" state offers "Open from GitHub Repo"**
  as a second way in, alongside "New workspace."

### Fixed

- **Disabled buttons across the app didn't look or act disabled.**
  Restore, several menu items, and the Share dropdown's chevron button
  could still show a hover highlight or (for one case) stay clickable
  entirely, despite doing nothing or erroring.
- **The editor and preview panes could look mismatched in width.** A
  fixed-width slot reserved for the comments panel wasted 320px even
  while collapsed; it now only holds that space while the panel is open
  or actively animating closed.
- **Closing the comments panel showed a brief glitch** — a shadow or
  sliver of the panel remained visible at the viewport's edge instead of
  disappearing cleanly.
- **Version History's Restore button now disables** when the selected
  version is already the current one, instead of staying clickable for
  a no-op restore.
- Plain `<select>` dropdowns (join-workspace, repo-conflict resolution)
  now pick up the app's theme instead of rendering with unstyled browser
  defaults.

## [1.23.0] - 2026-08-17

### Added

- **Share the whole workspace, not just one document.** The Share button
  on a document that has siblings now offers a choice — share just this
  document (the existing behavior) or the whole workspace — instead of
  always silently isolating the document into its own workspace first.
- **Open an existing GitHub repo directly as a new workspace.** File >
  Open > From GitHub Repo creates a workspace from any repo in one step
  (switching to an already-linked workspace instead of duplicating it if
  one already exists).
- **Linking an existing workspace to a repo now pushes and pulls
  automatically.** Previously this only saved the link, leaving the user
  to manually run Push then Pull afterward.
- **Document Info shows a linked repo/Gist.** The panel (File > Document
  Info) now shows a document's linked GitHub repo path or Gist, with a
  direct link to it on GitHub.
- **More readable relative dates.** Dates past yesterday now read "5d
  ago" / "2w ago" / "3mo ago" instead of jumping straight to a bare date
  — used everywhere relative dates already appeared (Document Info, File
  > Open Recent, Command Palette).
- **Progress toasts for GitHub repo sync and Gist publish.** Pushing,
  pulling, linking a workspace to a repo, opening a repo as a new
  workspace, and publishing a Gist now show a toast that updates live
  while the operation runs, instead of the only feedback being a menu
  button's own label — invisible whenever the modal that triggered the
  action is on top of that menu.
- **Move a document to a different workspace via a modal.** The doc-row
  "⋯" menu's "Move" action now opens a picker modal instead of listing
  every other workspace inline.

### Fixed

- **Confirm dialogs for delete actions (document, image, workspace) now
  name what's being deleted in the title** (`Delete "My Notes"?`) instead
  of a generic title with the name buried in the body text.
- **The Share dialog's title showed the active document's name even when
  sharing the whole workspace** — it now always reflects what's actually
  being shared.
- **Relinking a workspace to a different repo could falsely report a
  push conflict** if a doc's stale sync metadata from a previously-linked
  repo happened to match a same-named file in the new one. Linking now
  always clears that metadata first.

## [1.22.1] - 2026-08-17

### Fixed

- **The What's New carousel's screenshot left dead space instead of
  filling its slide.** It now fills the slide's full height and sits
  flush against the header and footer, matching the mobile layout's
  existing full-bleed treatment.
- **Workspace-level sharing (v1.21.0) never got a What's New entry** —
  added, with a real screenshot of the Share dialog.

## [1.22.0] - 2026-08-17

### Added

- **GitHub repo sync.** Link a workspace to a GitHub repo from File >
  GitHub Repo — every `.md` file in the repo becomes a doc, recursively
  through the whole tree. Pull the latest from the repo, or push local
  changes back out as a single commit; embedded images push alongside
  their doc as real files and resolve back on pull. Conflicts (a file
  changed on both sides since the last sync) always prompt a per-file
  "keep mine / take theirs" choice, never a silent overwrite. Deletions
  sync both directions. Requires re-connecting your GitHub account once
  (the sign-in scope changed from `gist` to `repo` to allow this).

### Fixed

- **The topbar stayed clickable behind an open modal.** A stacking-order
  bug meant the topbar's own menus (File/Edit/View/Help, Share,
  Settings) sat visually above every dialog's backdrop, so a click meant
  for the backdrop could still reach a topbar button while a modal was
  supposedly blocking the rest of the page.
- **A non-destructive confirmation ("Move to its own workspace?" when
  sharing a document) showed a delete-warning icon.** The confirm
  dialog's icon now matches whether the action is actually destructive.

## [1.21.1] - 2026-08-17

### Fixed

- **Workspace sharing didn't seed content or sync new documents both
  ways.** Sharing a document for the first time could leave
  collaborators looking at an empty doc, and newly created documents
  inside a shared workspace only synced from collaborator to owner,
  not back — both are now fixed and covered by regression tests.
- **GitHub sign-in could fail closed on transient errors.** Logging
  out now always clears the local session even if revoking the
  GitHub OAuth grant fails, and a network blip or rate-limited
  response no longer signs you out — only a definite invalid-token
  response does.
- **Preview scrolled to the wrong place while typing.** A coordinate
  math bug double-counted the preview pane's padding, causing a
  systematic offset between the cursor's position and what the
  preview showed. Lists also now track each item individually
  instead of only the list's first line, so long lists stay in sync
  too.

## [1.21.0] - 2026-08-16

### Added

- **Workspace-level sharing.** Sharing now happens at the workspace
  level instead of one document at a time — every document inside a
  shared workspace syncs live to collaborators simultaneously, not
  just whichever one is currently open. Sharing a single document
  (from its existing Share button) moves it into its own new
  workspace first if it isn't already alone in one, then shares that.
  Opening a shared workspace link for the first time now asks whether
  to add it as a new workspace of its own or merge its documents into
  one you already have. Version history and comments keep working
  exactly as before, just re-scoped to the workspace. The doc list
  shows a small presence indicator next to whichever document each
  collaborator currently has open, across the whole workspace.
  Documents shared before this release keep working — they migrate
  to the new model automatically and transparently the next time
  anyone opens them.

## [1.20.3] - 2026-08-16

### Fixed

- **Scroll sync between editor and preview.** A prior change increasing
  the editor's own top padding (for visual balance with the preview
  pane) exposed a coordinate-space bug in the scroll-sync math: some
  conversions between CodeMirror's document-relative coordinates and
  the DOM's physical scroll position were inconsistent, causing the
  preview to lag or overshoot the editor's actual scroll position.
  Fixed at the root (a shared, consistently-applied padding offset)
  rather than patched around, and both panes now reliably reach the
  true top/bottom of the document together, not just approximately.
- **Diagram Editor and Version History are full-screen tools again**,
  not small floating dialogs — an in-progress UI pass had wrapped both
  in the shared modal component, which doesn't fit either one's layout
  (a code+preview split pane, and a list+preview split pane).
- **`marked` (the Markdown parser) upgrade to v18 actually verified.**
  The dependency had been bumped in `package.json` but never installed
  or tested — doing so surfaced a real breaking change in the library's
  custom-renderer API (images, code blocks, and links would have
  rendered blank) that's now fixed and verified against images, links,
  wikilinks, code blocks (plain and Mermaid), tables, task lists, and
  footnotes.
- Mobile comments panel positioning, animation, and layout polish;
  minor desktop layout gap and z-index fixes.

### Changed

- Dependency updates: `svelte`, `wrangler`, `@cloudflare/workers-types`,
  `@sveltejs/vite-plugin-svelte`, `isomorphic-git`, `undici`, `marked`.
  Renovate now manages dependency update PRs for this repo.

## [1.20.2] - 2026-08-16

### Fixed

- **UI Polish.** Fixed the dynamic empty state title in the Open Gist modal to accurately reflect loading and error states instead of defaulting to "No gists". Upgraded the Version History and Document Headings (TOC) sidebars to use the new global empty state layout.

## [1.20.1] - 2026-08-16

### Fixed

- **UI Polish.** Refined empty states across all modals and sidebars (Settings, Document Info, Images, Command Palette, Open Gist, Comments) with a unified, visually balanced layout featuring centered icons and prominent titles.
- **Confirm Dialogs.** Upgraded confirmation dialogs to use descriptive header titles (e.g., "Delete Document?") instead of a generic "Confirm", backed by the new empty state body format and a trash can icon.
- **GitHub Auth Flow.** Added a direct "Sign in with GitHub" button to the empty state of the Open Gist modal, completely wiring it to authenticate and reload gists automatically without closing the modal.

## [1.20.0] - 2026-08-16

### Added

- **Workspaces.** Documents now live inside a named workspace — create,
  switch, rename, and delete workspaces from a new switcher in the
  sidebar header (one active at a time). Existing documents migrate
  transparently onto a default "My Workspace." A document can be moved
  to another workspace from its "⋮" menu. Deleting a workspace deletes
  its documents too, after a confirmation showing the count. This is
  purely local for now — the first step toward sharing an entire
  workspace with collaborators, not just one document at a time.

## [1.19.2] - 2026-08-15

### Added

- Modal header now has a bottom border separating it from the body,
  matching the footer's existing top border.

### Changed

- What's New now uses the shared `Modal` component (Standardized modal
  layout — Phase 2), closing out the modal-standardization work.

### Fixed

- On mobile, What's New's screenshot floated inset from the modal's
  edges instead of filling the width edge-to-edge like a proper hero
  image.

## [1.19.1] - 2026-08-14

### Added

- Modal hints ("?" button) now show as a small click-to-open popover
  anchored to the button, dismissing on outside click or Escape,
  instead of inserting a paragraph into the modal body.

### Fixed

- The comments panel rendered in the wrong place on desktop (not as a
  right-side column) — its Svelte mount wrapper was missing
  `display: contents`, so its `grid-area` assignment was silently
  ignored.
- The About modal used the app name and version as its own dialog
  title; it's "About" again, with "Markdown Editor" + version restored
  as a heading in the body next to the logo.
- No way to exit Focus Mode on mobile — the View menu's toggle lives
  in `#topbar`, which Focus Mode itself hides, and mobile has no
  Escape key. Added a small floating exit button, mobile-only.
- Two modal hints no longer matched actual behavior: Settings claimed
  GitHub sign-in "only affects Publish to Gist" (it also gates Share);
  Insert Link claimed leaving Text blank inserts "the URL on its own"
  (it always inserts `[link text](url)`, defaulting the text).

## [1.19.0] - 2026-08-14

### Added

- A shared `Modal` component now backs every simple dialog in the app
  (Sign in, Insert link, Images manager, Open from GitHub Gist,
  Keyboard Shortcuts, About, Terms, Privacy, Open Source Licenses,
  Settings, Document info, Rename collision, Share) — one consistent
  header (icon-only close button, title, optional quick-action link) /
  scrollable body / optional footer structure, replacing 13 different
  hand-rolled variants.
- A reusable `ConfirmDialog`, replacing both native `window.confirm()`
  popups in the app (deleting a document, deleting an image) with a
  styled dialog matching the rest of the UI.

### Fixed

- Long-content modals (Open Source Licenses, Keyboard Shortcuts,
  Settings) used to scroll the title and Close button away along with
  the content — only the body scrolls now, header and footer stay
  pinned.
- File/Edit/View/Help dropdown menus rendered behind the mobile
  formatting toolbar instead of above it (`#topbar` and `#toolbar` had
  landed on the same z-index).
- Version History's list and preview panes squeezed into an unreadable
  two-column layout on mobile — now stacks list above preview.

## [1.18.0] - 2026-08-14

### Added

- Mobile document sheet: a "Documents"/"Headings" tab bar replaces the
  per-row expandable outline — Headings shows the active document's
  full outline at the top level instead of nested under one row at a
  time, the remaining piece of the mobile redesign mockup. Desktop is
  unchanged; the tab bar and this behavior are mobile-only.

### Fixed

- Tapping a heading in the new Headings tab didn't close the mobile
  sheet — it always targets the already-active document, so the
  existing jump-to-line function's sheet-closing side effect (tied to
  actually switching documents) never fired for it.
- The Headings tab's own selection persisted across closing and
  reopening the sheet instead of always resetting to "Documents" —
  the sheet's open/closed state is a CSS transform, not conditional
  rendering, so the component backing it never remounts.
- The mobile sheets' dimming backdrops popped in/out instantly while
  the sheet itself and the header's dim overlay both faded smoothly —
  neither backdrop's visibility mechanism (the `hidden` attribute;
  conditional Svelte rendering) could be CSS-transitioned. Both now
  stay mounted and fade via an opacity class instead.
- The mobile document sheet flashed fully open on every page load
  before immediately sliding shut — the collapse only happened once a
  deferred module script ran, well after the browser's first paint. A
  blocking inline script now applies the collapsed state synchronously
  during HTML parsing, before anything renders.

## [1.17.1] - 2026-08-14

### Fixed

- A document row's "..." menu (Rename/Duplicate/Delete) could render
  partially or fully off-screen on the mobile bottom sheet, making
  Delete unreachable for rows near the sheet's bottom edge — two
  compounding bugs: the sheet's own slide animation gave it a
  `transform`, which silently broke the menu's fixed positioning
  (containing-block change), and the menu never checked whether it
  would overflow the bottom of the screen in the first place. It now
  positions correctly and flips to open above the row when there isn't
  room below.

## [1.17.0] - 2026-08-14

### Added

- The document sidenav and comments panel now present as native-style
  bottom sheets on mobile: flush to the screen's left/right/bottom
  edges with rounded top corners, a dimmed backdrop (the header dims
  too, while staying tappable), and tap-outside or the existing close
  button to dismiss. Opening either sheet closes the other, since two
  stacked sheets would otherwise collide.

### Fixed

- Comments had no mobile-specific layout at all before this — it used
  the same 320px desktop side panel, which squeezed the editor down to
  almost nothing on a phone whenever comments were open.
- Document title text was still getting clipped on mobile specifically
  — a leftover mobile-only override on the width-measuring mirror
  element assumed the title field also shrank to 16px there, which it
  never actually did once bumped to 18px.

## [1.16.0] - 2026-08-14

### Added

- View selector: two independent Editor pane / Preview pane toggle
  buttons in the toolbar (and matching entries in the View menu),
  replacing the old three-way Editor/Split/Preview switch — both on =
  split view, matching the original desktop layout mockup.
- The formatting toolbar collapses buttons that don't fit into a
  Google Docs-style "⋮" overflow menu instead of wrapping to a 2nd line
  or scrolling horizontally.

### Changed

- Desktop layout restructured to match the original mockup: the
  formatting toolbar now spans the document sidenav + editor + preview
  as one row (not just editor+preview), with the view selector in its
  own column aligned above the comment sidenav — both stay in sync via
  a shared CSS grid instead of two independently-sized rows.
- Topbar: the logo and the comments/history/share/settings cluster
  each span both header rows, the File/Edit/View/Help menu bar aligns
  under the document title instead of the logo, and the divider line
  between the two header rows is gone — all matching Google Docs'
  actual header layout more closely than the original approximation.
- The document sidenav toggle is now a single always-visible button
  with an active/inactive state, instead of two separate buttons
  swapping visibility depending on whether the sidenav is collapsed.

### Fixed

- Document title text (e.g. "Welcome", shown when no document is open)
  was getting clipped — the hidden mirror element used to measure the
  title field's width had drifted out of sync with the field's actual
  font/padding.
- Buttons and inputs across the app were rendering in the browser's
  default form-control font instead of the app's intended font — form
  controls don't inherit page font-family by default, and nothing had
  told them to.
- The document-sidenav toggle and toolbar overflow buttons were
  visibly bigger, and inconsistently spaced against their neighbors,
  than every other toolbar button — they shared a fixed-size class used
  elsewhere in the app instead of sizing like their actual neighbors.

## [1.15.5] - 2026-08-13

### Fixed

- iOS zoom-on-focus (v1.15.1) only covered the editor and title field
  — every other text field (comment drafts/replies, modal fields,
  the command palette) still triggered it. Now covers every text
  field in the app generically.

### Changed

- What's New's screenshot is bigger — it looked small even after
  fixing the crop.

## [1.15.4] - 2026-08-13

### Fixed

- What's New screenshots were forced into a fixed square and cropped
  if the source image wasn't already square. Now sized to each
  image's own natural aspect ratio instead.

## [1.15.3] - 2026-08-13

### Fixed

- Double-tapping anywhere on mobile triggered iOS Safari's default
  zoom gesture, which left the app's layout visibly broken (it wasn't
  built to handle an arbitrary zoomed-in state). Disabled double-tap
  -zoom specifically; pinch-to-zoom is untouched.

## [1.15.2] - 2026-08-13

### Changed

- Document Info moved out of the topbar into the File menu only, and
  now shows a full timestamp alongside its relative time ("Today" /
  "13 Aug 2026, 8:45 PM").
- The Comments panel now pushes the editor/preview narrower when
  opened instead of floating on top of them, and the topbar icon
  toggles it open/closed (previously only opened it) with an active
  state while open.

### Fixed

- Every modal in the app (including What's New's full-screen mobile
  layout) was rendering underneath the topbar instead of above it — a
  regression from v1.15.1's Comments-panel topbar fix.
- The rename-collision prompt (Replace/Save as/Cancel) had no way to
  dismiss it by clicking outside, unlike every other modal in the app.

## [1.15.1] - 2026-08-13

### Fixed

- Pasted/dropped images whose filename contained a space (nearly all
  of them — e.g. macOS's default "Screenshot ... at H.MM.SS PM.png"
  naming) never rendered, in the preview or on export. The generated
  reference embedded that space directly into `![alt](ref)` markdown
  syntax, which isn't valid without escaping, so it silently fell back
  to rendering as literal text instead of an image.
- Renaming a document and then updating its linked Gist created a
  second file in the gist instead of updating the existing one —
  GitHub's Gist API only updates a file in place when the request's
  filename key exactly matches an existing one.
- If a linked Gist was deleted outside the app, it stayed showing as
  linked indefinitely with no way to clear it.
- Tab now indents in the editor instead of doing nothing.
- The cursor landed _before_ an inserted heading/list/quote marker
  instead of after it when applied to an empty line.
- Checkbox list items showed a bullet dot next to the checkbox.
- The document title field's minimum width left a visible gap before
  the save-status icon on short names; pressing Enter there now
  commits the rename and moves focus to the editor.
- The text-selection highlight disappeared the moment you started
  typing a comment on it.
- The floating "Add comment" button could appear even with the
  Comments panel closed, and the open panel itself could cover the
  topbar's own buttons.
- The Images manager gave no indication when a still-listed image's
  reference had been removed from the document.
- Three mobile-specific issues: Safari zooming in on focusing the
  title field or editor and never zooming back out, the stacked
  editor/preview layout's scroll area getting clipped by `100vh` not
  accounting for the browser's own chrome, and the What's New modal
  cramming a fixed-width screenshot beside its text instead of using
  the full screen.

## [1.15.0] - 2026-08-13

### Added

- Wikilinks — type `[[Document Name]]` (autocompleted as you type) to
  link between documents. It renders as a clickable link in the
  preview: click to jump to that document, or create it if it doesn't
  exist yet.
- A merged Document Info panel (new topbar icon and File-menu entry)
  showing when a document was created/last edited, its word/character
  count, and which other documents link to it.

### Changed

- Document names are now enforced unique — creating or duplicating a
  document that would collide gets a silent `-2`, `-3`, ... suffix.
  Renaming a document to an existing name prompts to Replace the other
  document, Save as a suffixed name, or Cancel.
- Opening or switching to a document no longer moves it to the top of
  the sidebar — only an actual edit does.

### Fixed

- The Help menu's "What's New" entry silently did nothing once you'd
  already seen the latest update — it only ever computed what's still
  unseen, which is empty right after any release announcement closes.
  It now always reopens the full list on demand, while the automatic
  on-load popup still only surfaces what's actually new.

## [1.14.0] - 2026-08-13

### Changed

- What's New is now a data-driven, missed-updates carousel instead of a
  single screen listing everything at once. It shows only the entries
  newer than what you've already seen (just the newest for a first-time
  visitor), one at a time with Prev/Next and a screenshot per entry.

## [1.13.0] - 2026-08-13

### Added

- Threaded comments — select any text and click "Add comment" to anchor
  a note to it. On a document you haven't shared, it's a lightweight
  personal note; on a shared document, it's a full discussion thread
  with replies and resolve/reopen, gated by role (viewers can read,
  reviewers and editors can comment). Anchors track live edits and
  survive reloads by relocating their quoted text. Open the panel from
  File > Comments or the new speech-bubble icon next to Version History.

## [1.12.0] - 2026-08-13

### Added

- Version history with revert — every document, local or shared, now
  builds up automatic background snapshots as you edit (throttled to at
  most one every 5 minutes, capped at 50 per document). Open it from
  File > Version History or the new clock icon next to Share; select any
  past version to preview it read-only, then restore it — nothing in
  history is ever deleted by a restore, so a restore is itself undoable
  by restoring whatever was current before it.

## [1.11.0] - 2026-08-13

### Added

- Slash commands — type `/` at the start of an empty line to open an
  inline menu of block-level insertions (headings, blockquote, code
  block, lists, task list, table, horizontal rule, image, math,
  footnote, diagram), fuzzy-filterable and keyboard-navigable, anchored
  directly under the cursor.

## [1.10.0] - 2026-08-13

### Added

- Command Palette — press Ctrl/Cmd+Shift+P (or use the new Help menu
  entry) to open a searchable overlay that fuzzy-filters across every
  open document and ~35 app commands (formatting, file operations,
  export, view toggles, editing, help), keyboard-navigable end to end.

### Fixed

- The diagram editor's Export button (Copy as SVG / Download PNG) never
  actually opened its menu — a missing event-propagation guard let a
  global "close open dropdowns" listener strip the menu open state the
  instant it was set.

## [1.9.0] - 2026-08-13

### Added

- Vim and Emacs keybinding modes — a new Editor section in Settings lets
  you switch between Normal, Vim, and Emacs editing, persisted across
  sessions. A status bar indicator shows the current Vim mode
  (NORMAL/INSERT/VISUAL/...) live, or a static "EMACS" label in Emacs
  mode.

## [1.8.0] - 2026-08-13

### Added

- Open Source Licenses — a new entry in the About modal listing every
  direct dependency's name, version, and license, linked to its
  repository where available. Generated automatically from what's
  actually installed at build time, so it can never go stale.

## [1.7.0] - 2026-08-13

### Added

- Focus Mode — a new View menu toggle (exits on Escape) that dims every
  paragraph except the one you're editing, keeps your cursor's line
  vertically centered as you type (typewriter scrolling), and hides the
  toolbar, sidebar, menu bar, and status bar, without changing whatever
  view mode (editor/split/preview) you were already in.

## [1.6.1] - 2026-08-12

### Fixed

- Custom export CSS's `</style` escaping (added in v1.6.0 to stop the
  field from being able to break out of its `<style>` tag in an HTML
  export) only matched a literal lowercase `</style`. HTML end tags are
  matched case-insensitively, so a variant like `</STYLE>` could still
  close the tag early and let arbitrary markup follow it in the
  exported file. The check is now case-insensitive.

## [1.6.0] - 2026-08-12

### Added

- Custom CSS on export — a new field in Settings lets you write CSS that
  applies to HTML and PDF exports, overriding the built-in styling. The
  live preview is unaffected.

## [1.5.0] - 2026-08-12

### Added

- GFM footnote support — `[^1]` inline references and `[^1]: text`
  definitions, rendered as bare superscript markers with a collected
  "Footnotes" section at the document's end regardless of where each
  definition was typed, plus a toolbar button to insert an auto-numbered
  reference + definition pair.

## [1.4.5] - 2026-08-12

### Fixed

- Sync scroll now interpolates using each side's own rendered pixel
  height for a block, not its source line count — a long paragraph
  that wraps into many editor rows previously reported the same single
  line number throughout, so the preview stayed frozen at its start
  while scrolling through it, then any short paragraph right after got
  almost no share of the editor's scroll range and flew by in an
  instant.

## [1.4.4] - 2026-08-12

### Fixed

- Scrolling through the interior of a tall block (a long code fence, a
  big list) no longer looks stuck at the block's start on the other
  side — sync scroll now interpolates proportionally within a block's
  own line/pixel range, not just snapping to its top.

## [1.4.3] - 2026-08-12

### Fixed

- Scrolling either the editor or preview all the way to the end no longer
  leaves the other pane short of its own end — both now recognize "at the
  true end" and mirror it directly, instead of only snapping to the top
  of the last block, which could fall noticeably short once that block
  didn't exactly fill the remaining viewport height.

## [1.4.2] - 2026-08-12

### Fixed

- The preview now also follows the cursor while typing or navigating,
  not just when you scroll — v1.4.1's line-mapped sync only reacted to
  explicit scroll events, so editing a line already visible in the
  editor's viewport never brought its corresponding preview block into
  view, even when a tall diagram or image had pushed it far out of
  sight. Only scrolls the preview when the current block isn't already
  visible, so it doesn't jump around on every keystroke.

## [1.4.1] - 2026-08-12

### Fixed

- Synced scrolling between the editor and preview no longer desyncs on
  documents with a tall Mermaid diagram or large image — it now maps each
  preview block to the source line it was rendered from and snaps to the
  matching block, instead of matching raw scroll percentage (which broke
  down badly once one block's rendered height was very disproportionate
  to how many source lines it represented).

## [1.4.0] - 2026-08-12

### Added

- KaTeX math rendering in the live preview and exports — `$inline$` and
  `$$block$$` LaTeX, loaded lazily so documents without math pay no extra
  cost, plus a toolbar button to insert a math snippet.

### Fixed

- Mermaid diagrams no longer flash back to their raw source text on every
  keystroke anywhere in the document — an already-rendered, unchanged
  diagram is now preserved instead of being regenerated.
- Exported standalone HTML files with math now include KaTeX's stylesheet,
  so the math renders correctly instead of appearing unstyled.

## [1.3.0] - 2026-08-12

### Added

- Export a diagram as SVG (copied to the clipboard) or PNG (downloaded) from
  the diagram editor's new Export menu.
- Pan and zoom on the diagram editor's preview — scroll to zoom, drag to
  pan, with a "Reset view" button to snap back to the original position.
- Mermaid-aware syntax highlighting in the diagram editor's code pane,
  covering all seven supported diagram types.

### Fixed

- Diagram text now renders as native SVG rather than embedded HTML labels,
  fixing a browser security restriction that silently broke PNG export for
  every diagram.

## [1.2.0] - 2026-08-12

### Added

- Dedicated full-screen diagram editor — build a Mermaid diagram (any
  diagram type) in a proper code + live-preview workspace, with starter
  templates (flowchart, sequence, class, state, ER, Gantt, pie) and a
  collapsible syntax reference, opened from a new toolbar button.
- Hover over any diagram already in the document to reveal an Edit button
  that reopens it in the same editor, pre-loaded with its current source.
- Diagrams are stored by reference (mirroring how pasted images already
  work) — editing a diagram never touches the surrounding document text,
  and exporting or publishing to a Gist always resolves refs back to real,
  portable Mermaid syntax.

## [1.1.0] - 2026-08-12

### Added

- Mermaid diagram rendering in the live preview — fenced ` ```mermaid ` code
  blocks render as flowcharts/diagrams instead of plain code, matching the
  document's light/dark theme and updating as you type.
- Per-diagram error isolation — invalid Mermaid syntax shows an inline error
  on that one diagram without affecting the rest of the preview.
- `mermaid` loads lazily (dynamic import), only for documents that actually
  contain a diagram — no cost for documents that don't use one.

### Changed

- HTML, PDF, and plain-text export now wait for any in-flight diagram
  render to finish before reading the preview, so a diagram pasted
  immediately before exporting is captured rendered rather than as raw
  source.

## [1.0.0] - 2026-08-07

Initial release. See [README](README.md) for the full feature set as of
this release: live split-pane preview, CodeMirror 6 editing with GFM
support, multi-document sidebar, real-time multi-user collaboration
(Yjs-based, with viewer/reviewer/editor roles), GitHub sign-in with
Gist publish/open, local image support, import/export to Markdown,
HTML, PDF, and plain text, and light/dark theming.
