import type { Doc, Workspace } from "./types";
import { findBacklinks } from "./wikilinks";

export interface WikilinkRenamePlan {
  // Set only when the renamed document's own content contains a
  // self-referential [[OldName]] — needs the live editor, not a
  // docsStore write, since the renamed doc is always the open one.
  // See the design spec's "why there's no generic active-document
  // bucket" note: every rename in this app operates on the currently
  // active document, so the renamed doc IS the active one.
  selfReferenceDoc: Doc | null;
  localTargets: Doc[]; // plain writes via docsStore
  sharedTargets: { doc: Doc; workspace: Workspace }[]; // need the HTTP endpoint
}

// Pure — no store reads, no network, no DOM. No excludeId passed to
// findBacklinks (unlike DocInfoPanel's backlinks-panel use of it) —
// the renamed doc's own content is a legitimate candidate here, just
// routed to selfReferenceDoc instead of one of the other buckets.
export function planWikilinkRenameCascade(oldName: string, docs: Doc[], renamedDocId: string, workspaces: Workspace[]): WikilinkRenamePlan {
  const candidates = findBacklinks(oldName, docs);
  const plan: WikilinkRenamePlan = { selfReferenceDoc: null, localTargets: [], sharedTargets: [] };
  for (const doc of candidates) {
    if (doc.id === renamedDocId) {
      plan.selfReferenceDoc = doc;
      continue;
    }
    const workspace = workspaces.find((w) => w.id === doc.workspaceId);
    if (workspace?.shared && workspace.remoteId) plan.sharedTargets.push({ doc, workspace });
    else plan.localTargets.push(doc);
  }
  return plan;
}
