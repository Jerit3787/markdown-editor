// Lazily fetches and merges a repo-linked (not shared) doc's local-only
// companion history file — .mde/history/<slug>.json, written by
// repo-sync.ts's planPush/pushToRepo — into this device's local
// IndexedDB snapshots and doc.notes. See
// docs/superpowers/specs/2026-08-19-repo-local-history-sync-design.md.
//
// Fetched once per doc per session (not on every pull, and not every
// time a panel reopens), and shared between VersionHistory.svelte and
// CommentsPanel.svelte — the two panels that display this data — so
// whichever one opens first pays the cost and the other reuses it.
import { get } from "svelte/store";
import type { Doc, Note } from "./types";
import { workspacesStore } from "./stores/workspaces";
import { historyPathFor, decodeBase64Text } from "./repo-sync";
import { mergeSnapshotsFromRepo, type Snapshot } from "./history";
import { mergeDocNotes } from "./stores/docs";

const fetchedDocIds = new Set<string>();

// Test-only: the module-level cache above is intentionally session-
// lifetime (cleared by a page reload in production), but tests in the
// same process need to reset it between cases.
export function resetFetchedHistoryCache(): void {
  fetchedDocIds.clear();
}

export async function fetchAndMergeRepoHistory(doc: Doc): Promise<void> {
  if (!doc.repoPath || fetchedDocIds.has(doc.id)) return;
  fetchedDocIds.add(doc.id);
  const repoLink = get(workspacesStore).find((w) => w.id === doc.workspaceId)?.repoLink;
  if (!repoLink) return;
  const historyPath = historyPathFor(doc.repoPath);
  const encodedPath = historyPath.split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repoLink.branch)}`);
  } catch (err) {
    return;
  }
  if (!res.ok) return; // 404 = no companion file pushed yet; any other failure — best-effort, nothing to merge
  const data = (await res.json()) as { content: string; encoding: string };
  const raw = data.encoding === "base64" ? decodeBase64Text(data.content) : data.content;
  let parsed: { snapshots?: Snapshot[]; notes?: Note[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (parsed.snapshots?.length) await mergeSnapshotsFromRepo(doc.id, parsed.snapshots);
  if (parsed.notes?.length) mergeDocNotes(doc.id, parsed.notes);
}
