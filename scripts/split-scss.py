#!/usr/bin/env python3
# TEMPORARY — used only during the SCSS migration
# (docs/superpowers/plans/2026-08-21-scss-migration.md). Deleted after
# the migration is verified and committed.
#
# Parses client/src/style.scss into top-level "chunks" (a leading
# comment block plus the rule/@media/@keyframes that follows it),
# buckets each chunk into one of 15 partials by which known selector(s)
# it contains, and writes each partial file plus a rebuilt entry point.
# Preserves each chunk's exact original text verbatim — no
# reformatting, no reordering within a partial (chunks land in each
# partial in the same relative order they had in the original file).

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "client/src/style.scss"
STYLES_DIR = REPO_ROOT / "client/src/styles"

# Selector -> partial name. Built from the plan's
# "Selector-to-partial assignment" section.
PARTITION = {}


def assign(partial, selectors):
    for s in selectors:
        PARTITION[s] = partial


assign("topbar", [
    "#brand", "#topbar", "#topbar-row", "#topbarActionsCol", "#topbarRow1",
    ".topbar-actions", ".topbar-row", "#toolbar", "#toolbar-mount",
    ".toolbar-buttons", ".toolbar-overflow", ".toolbar-overflow-menu",
])
assign("sidebar", [
    "#sidebar", "#sidebarHeader", "#sidebarHeaderLeft", "#sidebarToggleOut",
    "#docList", "#doclist-mount", ".doc-row", ".doc-row-link", ".doc-menu-btn",
    ".doc-menu-popover", ".doc-menu-submenu-label", ".doc-outline",
    ".doc-outline-toggle", ".doc-outline-toggle-spacer",
    ".doclist-headings-tab-label", ".doclist-presence", ".doclist-tabs",
    "#docTitle", "#docTitleMirror", "#sidebarBackdrop",
])
assign("editor-preview", [
    "#editor-mount", "#editorPane", "#editorWrap", "#preview", "#preview-mount",
    "#previewPane", ".outline-item", ".outline-list", ".focus-mode-exit-btn",
    ".view-selector", ".katex", ".cm-content",
])
assign("statusbar", [
    "#statusbar", ".statusbar-link", ".status-dot", "#saveStatusBtn",
    ".save-status-popup",
])
assign("menu", [
    "#menuBar", "#menubar-mount", ".menu-check", ".menu-chevron", ".menu-divider",
    ".menu-glyph-btn", ".menu-item", ".menu-link", ".menu-recent-empty",
    ".menu-recent-item", ".menu-recent-name", ".menu-recent-time",
    ".menu-section-label", ".menu-section-sublabel", ".menu-submenu",
    ".menu-submenu-panel", ".menu-submenu-trigger", ".menu-view-btn",
    ".menubar-btn", ".menubar-menu", ".keybinding-mode-indicator",
])
assign("command-palette", [
    ".command-palette", ".command-palette-backdrop", ".command-palette-input",
    ".command-palette-input-row", ".command-palette-results",
    ".command-palette-row",
])
assign("modals", [
    ".modal-actions", ".modal-actions-share", ".modal-backdrop", ".modal-body",
    ".modal-box", ".modal-box-v2", ".modal-box-wide", ".modal-close-btn",
    ".modal-content", ".modal-field", ".modal-footer", ".modal-header",
    ".modal-hint", ".modal-tabs", ".about-brand", ".about-links", ".about-title",
    ".about-version", ".setting-desc", ".setting-label", ".setting-row",
    ".setting-title", ".settings-row", ".custom-css-input", ".shortcuts-list",
    ".shortcuts-row", ".whats-new-counter", ".whats-new-nav",
    ".whats-new-screenshot", ".whats-new-slide", ".whats-new-text",
])
assign("comments", [
    ".comment-add-btn", ".comment-body", ".comment-delete-btn",
    ".comment-draft-actions", ".comment-draft-anchor", ".comment-draft-box",
    ".comment-entry", ".comment-entry-quote", ".comment-orphaned-label",
    ".comment-reply-row", ".comments-panel", ".comments-panel-header",
    ".comments-panel-list", "#comments-panel-mount",
])
assign("share-workspace", [
    ".share-access-icon", ".share-access-mirror", ".share-access-row",
    ".share-access-select", ".share-access-text", ".share-add-people-input",
    ".share-btn-group", ".share-name-row", ".share-people-list", ".share-person",
    ".share-person-name", ".share-person-remove", ".share-person-role",
    ".share-pill", ".share-pill-label", ".share-role-select", ".share-row", ".presence-avatar",
    ".presence-avatar-sm", ".presence-bar", ".workspace-list",
    ".workspace-new-btn", ".workspace-rename-input", ".workspace-row",
    ".workspace-row-name", ".workspace-switcher", ".workspace-switcher-popover",
    ".workspace-switcher-trigger",
])
assign("diagram-editor", [
    ".diagram-editor-body", ".diagram-editor-code-host", ".diagram-editor-header",
    ".diagram-editor-overlay", ".diagram-editor-preview",
    ".diagram-editor-preview-wrap", ".diagram-editor-reference",
    ".diagram-preview-reset", ".diagram-template-card", ".diagram-template-grid",
    ".diagram-template-or", ".diagram-template-picker",
])
assign("diff-view", [
    ".diff-image-loading", ".diff-image-thumb", ".diff-view", ".diff-view-cell",
    ".diff-view-gutter", ".diff-view-mode-toggle", ".diff-view-row",
    ".diff-view-unified", ".version-history-actions", ".version-history-body",
    ".version-history-current", ".version-history-header",
    ".version-history-list", ".version-history-overlay",
    ".version-history-preview", ".version-history-preview-wrap",
    ".version-history-row", ".version-history-row-label",
    ".version-history-view-toggle", ".doc-info-backlink-row",
    ".doc-info-backlinks", ".doc-info-link", ".doc-info-primary",
    ".doc-info-row", ".doc-info-secondary",
])
assign("slash-wikilink", [".slash-menu", ".slash-menu-row"])
assign("utilities", [
    ".dropdown", ".dropdown-divider", ".dropdown-menu", ".dropdown-text",
    ".dropdown-text-desc", ".dropdown-text-title", ".empty-state",
    ".empty-state-actions", ".empty-state-desc", ".empty-state-icon",
    ".empty-state-inner", ".empty-state-title", ".gist-item", ".hint-text",
    ".hint-toggle-btn", ".icon", ".icon-btn", ".image-item",
    ".image-unused-label", ".images-list", ".primary-btn", ".secondary-btn",
    ".danger-btn", ".sep", ".skeleton", ".spacer", ".sr-only", ".desktop-only",
    ".tab-switch", ".tab-switch-btn", ".toast", ".toast-close", ".toast-error",
    ".toast-message", ".toast-stack", ".toast-success", ".toggletip",
    ".toggletip-bubble", ".mobile-sheet-backdrop",
])
assign("layout", ["#app", "#body", "#main", "#content-row", "#divider", ".pane"])
assign("variables", [":root", "*", "html", "body"])

PARTIAL_ORDER = [
    "variables", "layout", "topbar", "sidebar", "editor-preview", "statusbar",
    "menu", "command-palette", "modals", "comments", "share-workspace",
    "diagram-editor", "diff-view", "slash-wikilink", "utilities",
]


def extract_selectors(header):
    """Pull every bare selector token (#id or .class) out of a rule's
    selector-list header, including descendant/compound selectors and
    :pseudo-class-qualified ones, so `#topbarActionsCol .icon-btn:hover`
    yields both #topbarActionsCol and .icon-btn."""
    return re.findall(r'[#.][A-Za-z][A-Za-z0-9_-]*', header)


BASE_RESET_HEADERS = {
    "[hidden]",
}


def classify(header, body_text):
    """Return the partial name for a chunk given its selector-list
    header text (and, for @media blocks, its body too — the header
    alone is just the media condition). Falls back to None (caller
    must handle) if nothing matches."""
    header = header.strip()
    if header.startswith("@keyframes"):
        return "utilities"  # shimmer, per the plan's Global Constraints note
    if header.startswith("@import"):
        return "__entry__"  # stays in the entry point, not a partial
    if header.startswith(":root") or header.startswith('[data-theme'):
        return "variables"
    if header in ("*", "html,", "html", "body", "html,\nbody"):
        return "variables"
    if header in BASE_RESET_HEADERS:
        return "variables"
    if re.match(r'^(button|input|select|textarea)\s*,', header) or \
       re.match(r'^(button|input|select|textarea)$', header):
        return "variables"

    if header.startswith("@media") or header.startswith("@supports"):
        # Classify by the selectors found in the block's BODY, not the
        # (selector-free) media-condition header.
        tokens = extract_selectors(body_text)
    else:
        tokens = extract_selectors(header)

    if not tokens:
        return None

    votes = {}
    for t in tokens:
        p = PARTITION.get(t)
        if p:
            votes[p] = votes.get(p, 0) + 1
    if not votes:
        return None
    # majority owner; ties broken by first-seen selector's partial
    best = max(votes.items(), key=lambda kv: kv[1])[0]
    return best


def parse_chunks(text):
    """Split the stylesheet into a list of (header, full_text) chunks.
    Each chunk is one top-level statement: a rule, @media block,
    @keyframes block, or @import line, WITH any immediately preceding
    comment block(s) attached as part of its full_text (so the comment
    travels with the rule it documents)."""
    i = 0
    n = len(text)
    chunks = []
    pending_comment = ""

    def skip_ws(i):
        while i < n and text[i] in " \t\r\n":
            i += 1
        return i

    while i < n:
        j = skip_ws(i)
        if j >= n:
            break
        if text[j:j+2] == "/*":
            end = text.find("*/", j + 2)
            end = end + 2 if end != -1 else n
            pending_comment += text[i:end]
            i = end
            continue
        if text[j] == "@" and text[j:j+7] == "@import":
            end = text.find(";", j)
            end = end + 1 if end != -1 else n
            full = pending_comment + text[i:end]
            header = text[j:end]
            chunks.append((header, full))
            pending_comment = ""
            i = end
            continue
        # find header up to first '{'
        brace = text.find("{", j)
        if brace == -1:
            # trailing content with no rule (shouldn't happen) - attach as-is
            chunks.append((text[j:], pending_comment + text[i:]))
            pending_comment = ""
            break
        header = text[j:brace]
        # now find matching closing brace, tracking nesting depth
        depth = 1
        k = brace + 1
        while k < n and depth > 0:
            if text[k] == "{":
                depth += 1
            elif text[k] == "}":
                depth -= 1
            k += 1
        full = pending_comment + text[i:k]
        chunks.append((header, full))
        pending_comment = ""
        i = k
    return chunks


def split_media_block(header, full):
    """A @media/@supports block can bundle overrides for many different
    components together. Recurse into its body, classify each inner
    rule on its own, and re-wrap each one in the same media condition
    when handing it back — so e.g. a mobile override for #sidebar ends
    up in _sidebar.scss's own @media block, not lumped in with every
    other component's mobile overrides in whichever partial won a
    majority vote over the whole block."""
    brace = full.find("{")
    body = full[brace + 1: full.rfind("}")]
    inner_chunks = parse_chunks(body)
    results = []  # list of (partial_or_None, wrapped_text)
    for inner_header, inner_full in inner_chunks:
        p = classify(inner_header, inner_full)
        wrapped = f"{header.strip()} {{\n{inner_full.strip()}\n}}\n"
        results.append((p, wrapped))
    return results


def main():
    text = SRC.read_text(encoding="utf-8")
    chunks = parse_chunks(text)

    buckets = {name: [] for name in PARTIAL_ORDER}
    entry_extra = []  # @import and anything else staying in the entry point
    unclassified = []

    for header, full in chunks:
        stripped_header = header.strip()
        if stripped_header.startswith("@media") or stripped_header.startswith("@supports"):
            for p, wrapped in split_media_block(header, full):
                if p is None:
                    unclassified.append((stripped_header[:40] + " > (inner rule)", wrapped))
                else:
                    buckets[p].append(wrapped)
            continue
        partial = classify(header, full)
        if partial == "__entry__":
            entry_extra.append(full)
        elif partial is None:
            unclassified.append((header.strip()[:80], full))
        else:
            buckets[partial].append(full)

    if unclassified:
        print(f"UNCLASSIFIED: {len(unclassified)} chunk(s):", file=sys.stderr)
        for header, full in unclassified:
            print(f"  header={header!r} (len={len(full)} chars)", file=sys.stderr)
        sys.exit(1)

    STYLES_DIR.mkdir(parents=True, exist_ok=True)
    for name in PARTIAL_ORDER:
        content = "\n\n".join(c.strip() for c in buckets[name]) + "\n"
        (STYLES_DIR / f"_{name}.scss").write_text(content, encoding="utf-8")
        print(f"{name}: {len(buckets[name])} chunk(s), {len(content)} chars")

    # Sass requires @use to appear before any other rule, including a
    # plain-CSS @import — so @use goes first even though the original
    # file had @import "katex/..." as its very first line.
    entry = "\n".join(f'@use "./styles/{name}";' for name in PARTIAL_ORDER) + "\n\n"
    entry += "\n".join(e.strip() for e in entry_extra) + "\n"
    SRC.write_text(entry, encoding="utf-8")
    print(f"\nEntry point rewritten: {SRC}")


if __name__ == "__main__":
    main()
