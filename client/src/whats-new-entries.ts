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
    description:
      "Press Ctrl/Cmd+Shift+P (or use Help > Command Palette) to search and run any command, or jump straight to any open document by name.",
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
      "Documents now live inside a named workspace — switch, create, rename, or delete one from the new switcher in the sidebar. Existing documents move onto a default \"My Workspace\" automatically, and you can move a document to a different workspace from its \"⋮\" menu.",
    screenshot: "/whats-new/workspaces.png",
  },
];
