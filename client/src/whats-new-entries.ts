export type WhatsNewCategory = "Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation";

export interface WhatsNewEntry {
  version: string;
  title: string;
  description: string;
  screenshot: string; // client/public/ path, e.g. "/whats-new/threaded-comments.png"
  category: WhatsNewCategory;
}

// Oldest first. Appending one entry here is the only step required to
// announce a new release — see whats-new.ts and WhatsNew.svelte for how
// CURRENT_VERSION (from __APP_VERSION__) and this array interact.
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
  {
    version: "1.10.0",
    title: "Command Palette",
    description: "Press Ctrl/Cmd+Shift+P (or use Help > Command Palette) to search and run any command, or jump straight to any open document by name.",
    screenshot: "/whats-new/command-palette.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.11.0",
    title: "Slash Commands",
    description:
      "Type / at the start of an empty line to insert headings, lists, tables, code blocks, and more — fuzzy-filter by typing after the slash, then Enter or Tab to pick.",
    screenshot: "/whats-new/slash-commands.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.12.0",
    title: "Version History",
    description:
      "Every document now builds up automatic version history as you edit. Open it from File > Version History or the clock icon next to Share, preview any past version, and restore it — nothing is ever deleted, so a restore is itself undoable.",
    screenshot: "/whats-new/version-history.png",
    category: "Version History",
  },
  {
    version: "1.13.0",
    title: "Threaded Comments",
    description:
      'Select any text and click "Add comment" to anchor a note to it — a personal note on your own documents, or a full discussion thread with replies and resolve/reopen once a document is shared. Open the panel from File > Comments or the icon next to Version History.',
    screenshot: "/whats-new/threaded-comments.png",
    category: "Collaboration",
  },
  {
    version: "1.15.0",
    title: "Wikilinks",
    description:
      "Type [[Document Name]] (autocompleted as you type) to link between documents — click a link in the preview to jump there, or create it if it doesn't exist yet. Document names are now unique, and a new Document Info panel shows a document's metadata plus which other documents link to it.",
    screenshot: "/whats-new/wikilinks.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.20.0",
    title: "Workspaces",
    description:
      'Documents now live inside a named workspace — switch, create, rename, or delete one from the new switcher in the sidebar. Existing documents move onto a default "My Workspace" automatically, and you can move a document to a different workspace from its "⋮" menu.',
    screenshot: "/whats-new/workspaces.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.21.0",
    title: "Workspace-Level Sharing",
    description:
      "Sharing now happens at the workspace level — every document inside a shared workspace syncs live to collaborators at once, not just whichever one is open. Add people by GitHub username or share a link, and set per-person or general-access roles right from the Share dialog. Sharing a single document just moves it into its own workspace first, then shares that.",
    screenshot: "/whats-new/workspace-sharing.png",
    category: "Collaboration",
  },
  {
    version: "1.22.0",
    title: "GitHub Repo Sync",
    description:
      "Link a workspace to a GitHub repo from File > GitHub Repo — every .md file in the repo becomes a doc, recursively. Push local changes back out as one commit, or pull the latest from GitHub, with per-file conflict detection: anything changed on both sides always asks you to pick a side, never silently overwrites.",
    screenshot: "/whats-new/github-repo-sync.png",
    category: "GitHub Integration",
  },
  {
    version: "1.23.0",
    title: "Open GitHub Repo as Workspace",
    description:
      "File > Open > From GitHub Repo creates a workspace from any repo in one step. Linking an existing workspace to a repo now pushes and pulls automatically instead of just saving the link, and repo/Gist actions show a live-updating progress toast so you can actually see what's happening.",
    screenshot: "/whats-new/open-repo-as-workspace.png",
    category: "GitHub Integration",
  },
  {
    version: "1.24.0",
    title: "Version History Meets Repo Commits",
    description:
      "On a repo-linked document, Version History now shows the repo's commits for that file alongside your local snapshots, all in one timeline. Toggle to Diff to compare any version against your current content, and restore straight from a commit — on shared documents too.",
    screenshot: "/whats-new/version-history-repo-commits.png",
    category: "Version History",
  },
  {
    version: "1.25.0",
    title: "A URL for Every Document",
    description:
      "Each tab now has its own document — the URL updates as you switch, deep links open the right document directly, and browser back/forward moves between them. Ctrl/Cmd-click (or middle-click) a document in the sidebar to open it in a genuine new tab, Google-Docs style.",
    screenshot: "/whats-new/tab-per-document-routing.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.26.0",
    title: "GitHub-Style Diffs",
    description:
      "The diff view now has line numbers, word-level highlighting for exactly what changed within a line, and a Split/Unified toggle. Images render as before/after thumbnails too, instead of raw text — for local documents, shared documents, and repo commits alike.",
    screenshot: "/whats-new/github-style-diff-view.png",
    category: "Version History",
  },
  {
    version: "1.27.0",
    title: "Portable Local History",
    description:
      "Version History and personal notes on a repo-linked document now travel with the repo instead of staying stuck on whichever device created them. Push bundles your local snapshots and notes into the commit; opening the doc anywhere else pulls them back in automatically.",
    screenshot: "/whats-new/portable-local-history.png",
    category: "Version History",
  },
  {
    version: "1.28.0",
    title: "Shared Document Names Sync",
    description:
      "Renaming a shared document now shows up for every collaborator immediately, instead of staying stuck on whichever browser made the change until it happened to reload. The name travels over the same live connection as the document's content and images.",
    screenshot: "/whats-new/shared-document-name-sync.png",
    category: "Collaboration",
  },
  {
    version: "1.29.0",
    title: "Search and Replace",
    description: "Ctrl/Cmd+F opens a find bar with a live match count and case/whole-word/regex toggles. Ctrl/Cmd+H expands it into Replace and Replace All.",
    screenshot: "/whats-new/search-and-replace.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.30.0",
    title: "Unresolved-Comment Badge",
    description:
      "The Comments topbar icon and File menu entry now show a live count of unresolved comment threads on a shared document, so outstanding feedback is visible before you even open the panel.",
    screenshot: "/whats-new/unresolved-comment-badge.png",
    category: "Collaboration",
  },
  {
    version: "1.31.0",
    title: "Toolbar Undo, Redo & Command Palette",
    description:
      "Undo and Redo now sit at the start of the toolbar (always visible, never hidden in the overflow menu), and a Command Palette quick-access icon sits at the end — previously only reachable via keyboard shortcut or a menu.",
    screenshot: "/whats-new/toolbar-undo-redo-command-palette.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.32.0",
    title: "Insert Existing Image & Replace",
    description:
      "The Insert image toolbar button now opens a picker of every image already in the document — click one to insert it, or upload a new one from the same place. Each image also gets a Replace action to swap its underlying file in place, everywhere it's referenced.",
    screenshot: "/whats-new/insert-existing-and-replace-image.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.33.0",
    title: "Printing Support",
    description:
      "A new Print action in the File menu and Command Palette opens the browser's native print dialog with a dedicated print layout — chrome-free, titled with the document name, and paginated cleanly across pages.",
    screenshot: "/whats-new/print-support.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.34.0",
    title: "Choose Gist Visibility",
    description:
      "Publishing a document to Gist for the first time now lets you choose Public or Secret before it's created — GitHub only accepts this choice at creation, so it can't be changed later, and updating an already-published document skips the prompt.",
    screenshot: "/whats-new/gist-visibility.png",
    category: "GitHub Integration",
  },
  {
    version: "1.35.0",
    title: "Markdown Compatibility Checker",
    description:
      "Document Info now has a Compatibility row that flags constructs which won't render the same elsewhere — wikilinks and image/diagram references that are app-only, plus GFM/math extensions that work here and on GitHub but aren't guaranteed everywhere. Click any flagged item to jump right to it.",
    screenshot: "/whats-new/markdown-compatibility-checker.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.36.0",
    title: "MultiMarkdown Syntax Support",
    description:
      "Definition lists and superscript/subscript now render correctly, and a new Metadata section in Document Info lets you add Title/Author/etc. fields that round-trip as real MultiMarkdown text on export, Gist publish, and repo push.",
    screenshot: "/whats-new/multimarkdown-syntax-support.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.37.0",
    title: "Citations & Bibliography",
    description:
      "Add [@key] or [#key] citations that resolve against a bibliography — numbered or inline author-year style, typed directly in the document or managed as structured entries in a new Citations section in Document Info. Round-trips as real reference text on export, Gist publish, and repo push.",
    screenshot: "/whats-new/citations-and-bibliography.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.37.0",
    title: "Format and Insert Menus",
    description:
      "Bold/Italic/Strikethrough and Insert Link/Insert Image/Manage Images now live in their own Format and Insert menus instead of being crowded into Edit. Nothing about how they work changed — just where to find them.",
    screenshot: "/whats-new/split-format-insert-menus.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.37.0",
    title: "Smart Version History Grouping",
    description:
      "Version History now groups continuous edits into collapsible sessions instead of a flat list, with much finer-grained capture underneath. Compare any two historical entries against each other, not just a version against the live document.",
    screenshot: "/whats-new/smart-version-history-grouping.png",
    category: "Version History",
  },
  {
    version: "1.38.0",
    title: "Document Info Edit Modal",
    description:
      "Document Info is now a read-only summary — including a new Name row — with an Edit button that opens a dedicated modal for renaming the document and editing its metadata and citation settings.",
    screenshot: "/whats-new/doc-info-edit-modal.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.39.0",
    title: "Suggestion-Mode Collaboration",
    description:
      "The reviewer role now proposes edits instead of being read-only — insertions and deletions show up as tracked, per-suggestion changes the document's editor can accept, reject, or that the reviewer can withdraw. Viewer role is now Preview-only, with no edit surface at all.",
    screenshot: "/whats-new/suggestion-mode-collaboration.png",
    category: "Collaboration",
  },
  {
    version: "1.40.0",
    title: "Categorized What's New",
    description:
      "Reopening What's New from the Help menu now starts at a category index instead of a 27-entry stepper from the very first release — pick a topic to step through just its updates, with a Done button that returns you to the index instead of closing the whole thing.",
    screenshot: "/whats-new/categorized-whats-new.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.41.0",
    title: "Shared-Workspace Previews",
    description:
      'Opening a share link now previews it instead of permanently cluttering your sidebar — look first, and click "Keep this workspace" only if you want to hang onto it. Closing or reloading the tab drops an unpicked preview.',
    screenshot: "/whats-new/shared-workspace-preview.png",
    category: "Collaboration",
  },
  {
    version: "1.42.0",
    title: "Wikilink Rename Cascade",
    description:
      "Renaming a document now automatically fixes every [[Name]] reference to it elsewhere, instead of leaving them pointing at a name that no longer exists — including references in shared workspace documents you aren't currently connected to.",
    screenshot: "/whats-new/wikilink-rename-cascade.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.43.0",
    title: "Signed-Out Indicator",
    description:
      "If your GitHub session expires while you're the owner or an invited collaborator on a shared workspace, you'll now see a status bar indicator instead of silently landing in whatever role the link's general access grants. Click it to sign in again.",
    screenshot: "/whats-new/signed-out-indicator.png",
    category: "Collaboration",
  },
  {
    version: "1.44.0",
    title: "Live Documents, Live Everywhere",
    description: "A document created in a shared workspace now shows up immediately for everyone already connected, not just collaborators who join afterward.",
    screenshot: "/whats-new/live-mid-session-docs.png",
    category: "Collaboration",
  },
  {
    version: "1.44.0",
    title: "Access-Denied Banner",
    description:
      "A shared workspace you can no longer reach — an expired session, a revoked invite, a link that never granted you access — now says so clearly with a banner and a Sign-in button, instead of silently dropping you into a disconnected local copy.",
    screenshot: "/whats-new/workspace-access-denied.png",
    category: "Collaboration",
  },
  {
    version: "1.45.0",
    title: "Live Workspace Sync",
    description:
      "A shared workspace now mirrors the sharer's side completely, not just its documents' own content and names: the workspace's real name reaches every collaborator and updates live if it's renamed, and deleting a document removes it for everyone instead of leaving an orphaned copy behind.",
    screenshot: "/whats-new/live-workspace-sync.png",
    category: "Collaboration",
  },
  {
    version: "1.46.0",
    title: "Tabbed Image Picker",
    description:
      "Inserting an image now opens a dedicated picker: an Upload tab to drop files onto the modal or pick from your device, and an Existing tab to re-insert an image already in the document with one click. Oversized files are flagged in the modal instead of leaving a marker in your text. Replace and delete moved to their own Manage Images modal in the Insert menu.",
    screenshot: "/whats-new/image-picker.png",
    category: "Editing & Formatting",
  },
  {
    version: "1.47.0",
    title: "Sharing, Seen Correctly",
    description:
      'The access level shown next to the Share button now reflects the real setting instead of always saying "Restricted." And if you open Share on a workspace someone shared with you, you\'ll see the true access, the owner, and a working Copy link — with the controls only the owner can change clearly marked, instead of a dialog that looked broken.',
    screenshot: "/whats-new/share-collaborator-view.png",
    category: "Collaboration",
  },
  {
    version: "1.48.0",
    title: "See Who Changed What",
    description:
      "Version History now shows a colour-coded avatar for every collaborator whose edits a version contains — on each version and each collapsed editing session — so you can tell at a glance whose work you're about to restore or compare.",
    screenshot: "/whats-new/version-history-authors.png",
    category: "Version History",
  },
  {
    version: "1.49.0",
    title: "Deleting a Shared Workspace Revokes Access",
    description:
      "Deleting a shared workspace you own now removes it for everyone you shared it with — the link stops working and connected collaborators are disconnected, with a banner explaining why. The confirmation dialog spells this out, and reads differently for a workspace shared with you (which just drops your local copy). A workspace that's both repo-synced and shared also keeps its repo-pulled files now, instead of losing them on the next sync.",
    screenshot: "/whats-new/shared-workspace-delete-revoke.png",
    category: "Collaboration",
  },
  {
    version: "1.50.0",
    title: "Work Below Your Role, and a Calmer Focus Mode",
    description:
      "A shared workspace now has an Editing / Suggesting / Viewing switcher next to Share — work below the access you were granted, and Viewing mode strips the app down to just the document. Publishing and repo sync are the workspace owner's controls only, collaborators can see when a workspace syncs to a repo, and on desktop a hint now tells you how to leave focus mode — which also dims the preview pane now, not just the editor.",
    screenshot: "/whats-new/focus-mode-polish.png",
    category: "Collaboration",
  },
  {
    version: "1.51.0",
    title: "Links Between Documents, and Safer Code Samples",
    description:
      "A plain markdown link to another document — [notes](Design%20Notes) or [api](docs/api.md) — now opens that document instead of a dead page. An unresolved one shows a clear “no such document” style. And [[wikilink]] syntax you type inside `code` or a fenced block is left exactly as written, in the preview and when a document is renamed. External links open in a new tab now.",
    screenshot: "/whats-new/preview-links.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.52.0",
    title: "A Clearer View-Only Mode",
    description:
      "When you're viewing or suggesting on a shared document, controls you can't use are greyed out instead of hidden — so the menu still teaches you the interface, the way Google Docs does. Version history is now an editing-mode tool, the Edit menu keeps Find and Copy in Viewing, deleting a document is the owner's call, and the mode switcher explains what each mode does.",
    screenshot: "/whats-new/collab-chrome-v2.png",
    category: "Collaboration",
  },
  {
    version: "1.53.0",
    title: "Ask for Edit Access",
    description:
      "Viewing or commenting on a shared document and need to make a change? The Share button now lets you request edit access from the owner, with an optional note. They approve or decline from the Share dialog — and an approval unlocks your editing tools on the spot, no reload.",
    screenshot: "/whats-new/request-access.png",
    category: "Collaboration",
  },
  {
    version: "1.54.0",
    title: "A Tidier Top Bar",
    description:
      "The top bar picks up a few Google-Docs habits: round icon buttons, a small label when you hover or keyboard-focus one, and a more compact Editing/Suggesting/Viewing switcher. When you're signed in with GitHub, your avatar now sits at the end of the bar — click it for your username or to sign out.",
    screenshot: "/whats-new/topbar-chrome.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.55.0",
    title: "Know Which Mode You're In",
    description:
      "In a shared document, switching between Editing, Suggesting, and Viewing — or just opening the workspace — now flashes a quick note like \"You're now suggesting\". A small reminder that your keystrokes become tracked suggestions, or that you're read-only, without hunting for the mode switcher in the corner.",
    screenshot: "/whats-new/mode-announce.png",
    category: "Collaboration",
  },
  {
    version: "1.56.0",
    title: "Top Bar, Tidied Further",
    description:
      "The Editing/Suggesting/Viewing switcher is now an outlined button like Google Docs, and its dropdown and mobile arrow are fixed. Your avatar is a little smaller, and Settings has moved into the account menu — click your avatar to reach Settings, see who you're signed in as, or sign out.",
    screenshot: "/whats-new/topbar-chrome-v2.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.57.0",
    title: "Analytics, Opt-In Only",
    description:
      "The app now has a Privacy Policy and Terms of Service as full pages (at /privacy and /terms), and an optional, privacy-respecting analytics setup: a one-time banner asks before anything is collected, you can toggle it in Settings, and it never sees your document content, titles, or username.",
    screenshot: "/whats-new/analytics-consent.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.58.0",
    title: "A Quick Human Check on Shared Links",
    description:
      "Opening a link-shared workspace while signed out now does a fast Cloudflare Turnstile check before the doc loads — usually you won't even see it, and it only happens once per link per browser session. It keeps automated abuse off public share links; signed-in collaborators are never asked.",
    screenshot: "/whats-new/turnstile.png",
    category: "Collaboration",
  },
  {
    version: "1.59.0",
    title: "Account Button, Tidied",
    description:
      "The signed-out account button now has a circle outline so it reads as a button, not a floating icon (it drops the outline once your avatar fills it). Settings loses its GitHub row too — connecting and disconnecting GitHub now live only in the account menu, next to sign-in and sign-out.",
    screenshot: "/whats-new/account-button-tidied.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.60.0",
    title: "Analytics, Now Cookieless by Default",
    description:
      'The usage analytics now run in an anonymous cookieless mode from the start — no cookie, no persistent ID, no cross-visit recognition, still no document content or username. The banner just asks whether to also allow a cookie for more accurate visit counts ("Allow" / "No cookies"); a browser Do-Not-Track / GPC signal still switches it off entirely. Privacy Policy updated to match.',
    screenshot: "/whats-new/analytics-cookieless.png",
    category: "Organization & Navigation",
  },
  {
    version: "1.61.0",
    title: "Comments and Suggestions, Side by Side",
    description:
      "Comments and tracked-change suggestions now live in one panel on the right, each card pinned next to the line it's about — no more suggestion cards wedged into the middle of your text. Switch to a plain list from the panel header any time; accept or reject a suggestion right on its card, and hover a highlight to light up its card.",
    screenshot: "/whats-new/annotation-rail.png",
    category: "Collaboration",
  },
  {
    version: "1.62.0",
    title: "Talk It Over on a Suggestion",
    description:
      "A tracked-change suggestion now has its own reply thread on its card — hash out the wording with your collaborators right there before anyone accepts or rejects it. Comments on a shared doc also sync instantly now instead of prompting everyone to refetch, and their anchors track your edits more closely.",
    screenshot: "/whats-new/suggestion-replies.png",
    category: "Collaboration",
  },
  {
    version: "1.63.0",
    title: "Guests Have Names Now",
    description:
      'Someone opening a shared link without signing in used to show up as "Anonymous" — the same as every other guest, so no one could tell them apart or even withdraw their own suggestion. Each guest now gets their own name (like "Quiet Lynx") that sticks with their suggestions, comments, edits in version history, and their live cursor. Signed-in collaborators are unchanged.',
    screenshot: "/whats-new/anon-identity.png",
    category: "Collaboration",
  },
  {
    version: "1.64.0",
    title: "One Card for a Line of Edits",
    description:
      "When someone leaves several small tracked-change suggestions on the same line, they now collapse into one card with a row per change — accept or reject each one, or the whole line at once, instead of wading through a stack of near-identical cards. A suggestion with an open reply thread stays on its own card.",
    screenshot: "/whats-new/suggestion-line-grouping.png",
    category: "Collaboration",
  },
];
