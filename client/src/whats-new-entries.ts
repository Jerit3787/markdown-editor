export interface WhatsNewEntry {
  version: string;
  title: string;
  description: string;
  screenshot: string; // client/public/ path, e.g. "/whats-new/threaded-comments.png"
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
  },
  {
    version: "1.11.0",
    title: "Slash Commands",
    description:
      "Type / at the start of an empty line to insert headings, lists, tables, code blocks, and more — fuzzy-filter by typing after the slash, then Enter or Tab to pick.",
    screenshot: "/whats-new/slash-commands.png",
  },
  {
    version: "1.12.0",
    title: "Version History",
    description:
      "Every document now builds up automatic version history as you edit. Open it from File > Version History or the clock icon next to Share, preview any past version, and restore it — nothing is ever deleted, so a restore is itself undoable.",
    screenshot: "/whats-new/version-history.png",
  },
  {
    version: "1.13.0",
    title: "Threaded Comments",
    description:
      'Select any text and click "Add comment" to anchor a note to it — a personal note on your own documents, or a full discussion thread with replies and resolve/reopen once a document is shared. Open the panel from File > Comments or the icon next to Version History.',
    screenshot: "/whats-new/threaded-comments.png",
  },
  {
    version: "1.15.0",
    title: "Wikilinks",
    description:
      "Type [[Document Name]] (autocompleted as you type) to link between documents — click a link in the preview to jump there, or create it if it doesn't exist yet. Document names are now unique, and a new Document Info panel shows a document's metadata plus which other documents link to it.",
    screenshot: "/whats-new/wikilinks.png",
  },
  {
    version: "1.20.0",
    title: "Workspaces",
    description:
      'Documents now live inside a named workspace — switch, create, rename, or delete one from the new switcher in the sidebar. Existing documents move onto a default "My Workspace" automatically, and you can move a document to a different workspace from its "⋮" menu.',
    screenshot: "/whats-new/workspaces.png",
  },
  {
    version: "1.21.0",
    title: "Workspace-Level Sharing",
    description:
      "Sharing now happens at the workspace level — every document inside a shared workspace syncs live to collaborators at once, not just whichever one is open. Add people by GitHub username or share a link, and set per-person or general-access roles right from the Share dialog. Sharing a single document just moves it into its own workspace first, then shares that.",
    screenshot: "/whats-new/workspace-sharing.png",
  },
  {
    version: "1.22.0",
    title: "GitHub Repo Sync",
    description:
      "Link a workspace to a GitHub repo from File > GitHub Repo — every .md file in the repo becomes a doc, recursively. Push local changes back out as one commit, or pull the latest from GitHub, with per-file conflict detection: anything changed on both sides always asks you to pick a side, never silently overwrites.",
    screenshot: "/whats-new/github-repo-sync.png",
  },
  {
    version: "1.23.0",
    title: "Open GitHub Repo as Workspace",
    description:
      "File > Open > From GitHub Repo creates a workspace from any repo in one step. Linking an existing workspace to a repo now pushes and pulls automatically instead of just saving the link, and repo/Gist actions show a live-updating progress toast so you can actually see what's happening.",
    screenshot: "/whats-new/open-repo-as-workspace.png",
  },
  {
    version: "1.24.0",
    title: "Version History Meets Repo Commits",
    description:
      "On a repo-linked document, Version History now shows the repo's commits for that file alongside your local snapshots, all in one timeline. Toggle to Diff to compare any version against your current content, and restore straight from a commit — on shared documents too.",
    screenshot: "/whats-new/version-history-repo-commits.png",
  },
  {
    version: "1.25.0",
    title: "A URL for Every Document",
    description:
      "Each tab now has its own document — the URL updates as you switch, deep links open the right document directly, and browser back/forward moves between them. Ctrl/Cmd-click (or middle-click) a document in the sidebar to open it in a genuine new tab, Google-Docs style.",
    screenshot: "/whats-new/tab-per-document-routing.png",
  },
  {
    version: "1.26.0",
    title: "GitHub-Style Diffs",
    description:
      "The diff view now has line numbers, word-level highlighting for exactly what changed within a line, and a Split/Unified toggle. Images render as before/after thumbnails too, instead of raw text — for local documents, shared documents, and repo commits alike.",
    screenshot: "/whats-new/github-style-diff-view.png",
  },
  {
    version: "1.27.0",
    title: "Portable Local History",
    description:
      "Version History and personal notes on a repo-linked document now travel with the repo instead of staying stuck on whichever device created them. Push bundles your local snapshots and notes into the commit; opening the doc anywhere else pulls them back in automatically.",
    screenshot: "/whats-new/portable-local-history.png",
  },
  {
    version: "1.28.0",
    title: "Shared Document Names Sync",
    description:
      "Renaming a shared document now shows up for every collaborator immediately, instead of staying stuck on whichever browser made the change until it happened to reload. The name travels over the same live connection as the document's content and images.",
    screenshot: "/whats-new/shared-document-name-sync.png",
  },
  {
    version: "1.29.0",
    title: "Search and Replace",
    description: "Ctrl/Cmd+F opens a find bar with a live match count and case/whole-word/regex toggles. Ctrl/Cmd+H expands it into Replace and Replace All.",
    screenshot: "/whats-new/search-and-replace.png",
  },
  {
    version: "1.30.0",
    title: "Unresolved-Comment Badge",
    description:
      "The Comments topbar icon and File menu entry now show a live count of unresolved comment threads on a shared document, so outstanding feedback is visible before you even open the panel.",
    screenshot: "/whats-new/unresolved-comment-badge.png",
  },
  {
    version: "1.31.0",
    title: "Toolbar Undo, Redo & Command Palette",
    description:
      "Undo and Redo now sit at the start of the toolbar (always visible, never hidden in the overflow menu), and a Command Palette quick-access icon sits at the end — previously only reachable via keyboard shortcut or a menu.",
    screenshot: "/whats-new/toolbar-undo-redo-command-palette.png",
  },
  {
    version: "1.32.0",
    title: "Insert Existing Image & Replace",
    description:
      "The Insert image toolbar button now opens a picker of every image already in the document — click one to insert it, or upload a new one from the same place. Each image also gets a Replace action to swap its underlying file in place, everywhere it's referenced.",
    screenshot: "/whats-new/insert-existing-and-replace-image.png",
  },
  {
    version: "1.33.0",
    title: "Printing Support",
    description:
      "A new Print action in the File menu and Command Palette opens the browser's native print dialog with a dedicated print layout — chrome-free, titled with the document name, and paginated cleanly across pages.",
    screenshot: "/whats-new/print-support.png",
  },
  {
    version: "1.34.0",
    title: "Choose Gist Visibility",
    description:
      "Publishing a document to Gist for the first time now lets you choose Public or Secret before it's created — GitHub only accepts this choice at creation, so it can't be changed later, and updating an already-published document skips the prompt.",
    screenshot: "/whats-new/gist-visibility.png",
  },
  {
    version: "1.35.0",
    title: "Markdown Compatibility Checker",
    description:
      "Document Info now has a Compatibility row that flags constructs which won't render the same elsewhere — wikilinks and image/diagram references that are app-only, plus GFM/math extensions that work here and on GitHub but aren't guaranteed everywhere. Click any flagged item to jump right to it.",
    screenshot: "/whats-new/markdown-compatibility-checker.png",
  },
];
