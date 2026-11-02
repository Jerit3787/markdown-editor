// Shared path conventions for the portable local-history companion file
// that repo sync and Drive folder sync both write. Kept dependency-free so
// stores/docs.ts can derive the path at delete time without importing
// repo-sync.ts (which imports the store back).

export function historyPathFor(docPath: string): string {
  return `.mde/history/${docPath.replace(/\.md$/i, "")}.json`;
}

// Map a companion history file back to its doc:
// ".mde/history/docs/notes.json" -> "docs/notes.md".
export function historyOwnerDocPath(historyPath: string): string | null {
  const match = /^\.mde\/history\/(.+)\.json$/.exec(historyPath);
  return match ? `${match[1]}.md` : null;
}
