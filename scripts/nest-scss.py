#!/usr/bin/env python3
# TEMPORARY — used only during the SCSS migration
# (docs/superpowers/plans/2026-08-21-scss-migration.md). Deleted after
# the migration is verified and committed.
#
# Adds &-nesting within each already-split partial file. Two safe,
# mechanical transforms only (both verified to be no-ops on compiled
# output via compare-scss-output.py after running):
#
#   1. Descendant nesting: if a rule's selector is exactly some
#      ancestor selector A (which also has its own top-level rule in
#      this file) followed by " " and more selector text, nest it
#      inside A's block as a plain descendant rule (no & needed —
#      "A { B { ... } }" means exactly "A B { ... }", unchanged).
#   2. Prefix &-nesting: if two or more same-type (both classes, or
#      both IDs) top-level selectors share a literal hyphenated prefix
#      AND that exact prefix also exists as its own top-level rule in
#      this file, nest the suffixed ones under it with &-suffix syntax
#      ("&-row" etc.).
#
# Groups with no existing base rule to nest under are left flat —
# inventing an empty wrapper rule just to nest siblings under it would
# add a rule to the compiled output that didn't exist before, which
# compare-scss-output.py's SET MATCH check would (correctly) flag.

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
STYLES_DIR = REPO_ROOT / "client/src/styles"


def parse_top_level_rules(text):
    """Split into (comment_prefix, selector_header, body, full_text)
    tuples for each top-level rule. Does not recurse into @media —
    those are left untouched (comment_prefix='', header=None marks a
    passthrough chunk)."""
    i = 0
    n = len(text)
    chunks = []
    pending_comment = ""
    while i < n:
        j = i
        while j < n and text[j] in " \t\r\n":
            j += 1
        if j >= n:
            break
        if text[j:j+2] == "/*":
            end = text.find("*/", j + 2)
            end = end + 2 if end != -1 else n
            pending_comment += text[i:end] + "\n"
            i = end
            continue
        if text[j] == "@":
            # @media, @keyframes, @import, etc. — passthrough untouched
            if text[j:j+7] == "@import":
                end = text.find(";", j) + 1
            else:
                brace = text.find("{", j)
                depth = 1
                k = brace + 1
                while k < n and depth > 0:
                    if text[k] == "{":
                        depth += 1
                    elif text[k] == "}":
                        depth -= 1
                    k += 1
                end = k
            chunks.append({"comment": pending_comment, "header": None, "body": None, "full": text[i:end]})
            pending_comment = ""
            i = end
            continue
        brace = text.find("{", j)
        if brace == -1:
            chunks.append({"comment": pending_comment, "header": None, "body": None, "full": text[i:]})
            pending_comment = ""
            break
        header = text[j:brace].strip()
        depth = 1
        k = brace + 1
        while k < n and depth > 0:
            if text[k] == "{":
                depth += 1
            elif text[k] == "}":
                depth -= 1
            k += 1
        body = text[brace + 1:k - 1]
        chunks.append({"comment": pending_comment, "header": header, "body": body, "full": None})
        pending_comment = ""
        i = k
    return chunks


def render_rule(comment, header, body, indent=""):
    out = ""
    if comment:
        out += "\n".join(indent + l if l.strip() else "" for l in comment.rstrip("\n").split("\n")) + "\n"
    out += f"{indent}{header} {{\n"
    body_lines = body.strip("\n").split("\n")
    for l in body_lines:
        out += f"{indent}  {l.strip()}\n" if l.strip() else "\n"
    out += f"{indent}}}\n"
    return out


def nest_file(path):
    text = path.read_text(encoding="utf-8")
    chunks = parse_top_level_rules(text)

    # index simple (single-selector, no comma, no combinator) rule headers
    simple_selector_idx = {}
    for idx, c in enumerate(chunks):
        h = c["header"]
        if h and "," not in h and " " not in h.strip() and ":" not in h.split("[")[0]:
            simple_selector_idx[h] = idx
        elif h and "," not in h and " " not in h.strip():
            # allow pseudo-class-free plain selectors with attribute
            # selectors like [type="text"] attached directly (no space)
            simple_selector_idx.setdefault(h, idx)

    consumed = set()
    output_order = []  # list of rendered strings or ("group", parent_idx, [child_idx,...])

    # 1) descendant nesting: any rule "A B..." where "A" is itself a
    # known simple top-level selector in this file becomes a child of A.
    children_of = {}
    for idx, c in enumerate(chunks):
        h = c["header"]
        if not h or "," in h:
            continue
        m = re.match(r'^([#.][A-Za-z][A-Za-z0-9_-]*)\s+(.+)$', h)
        if m:
            ancestor, rest = m.group(1), m.group(2)
            if ancestor in simple_selector_idx and simple_selector_idx[ancestor] != idx:
                parent_idx = simple_selector_idx[ancestor]
                children_of.setdefault(parent_idx, []).append(idx)
                consumed.add(idx)

    # 2) prefix &-nesting among simple selectors sharing a hyphenated
    # stem that also exists as its own top-level rule.
    #
    # Skip any selector that's already a PARENT from step 1
    # (children_of) — this script only renders one level of nesting, so
    # a rule that is itself an ancestor for some descendant selector
    # must stay a top-level rendering target, or its own children would
    # be silently dropped (found live: .icon-btn is the ancestor for
    # ".icon-btn .icon", but .icon-btn also looks like a "-btn" suffix
    # of the unrelated base ".icon" — nesting .icon-btn under .icon
    # orphaned ".icon-btn .icon" entirely).
    for idx, c in enumerate(chunks):
        h = c["header"]
        if not h or idx in consumed or idx in children_of or "," in h or " " in h.strip():
            continue
        m = re.match(r'^([#.])([A-Za-z][A-Za-z0-9_]*)-([A-Za-z0-9_-]+)$', h)
        if not m:
            continue
        sigil, stem, suffix = m.groups()
        base = f"{sigil}{stem}"
        if base in simple_selector_idx and simple_selector_idx[base] != idx:
            parent_idx = simple_selector_idx[base]
            children_of.setdefault(parent_idx, []).append(("suffix", idx, "-" + suffix))
            consumed.add(idx)

    # render
    rendered_indices = set()
    out_parts = []
    for idx, c in enumerate(chunks):
        if idx in consumed:
            continue
        if c["header"] is None:
            out_parts.append(c["comment"] + c["full"])
            continue
        kids = children_of.get(idx, [])
        if not kids:
            out_parts.append(render_rule(c["comment"], c["header"], c["body"]))
        else:
            block = ""
            if c["comment"]:
                block += c["comment"]
            block += f'{c["header"]} {{\n'
            for l in c["body"].strip("\n").split("\n"):
                block += f"  {l.strip()}\n" if l.strip() else "\n"
            for kid in kids:
                if isinstance(kid, tuple) and kid[0] == "suffix":
                    _, kidx, suffix_sel = kid
                    kc = chunks[kidx]
                    block += "\n"
                    if kc["comment"]:
                        block += "\n".join("  " + l if l.strip() else "" for l in kc["comment"].rstrip("\n").split("\n")) + "\n"
                    block += f'  &{suffix_sel} {{\n'
                    for l in kc["body"].strip("\n").split("\n"):
                        block += f"    {l.strip()}\n" if l.strip() else "\n"
                    block += "  }\n"
                else:
                    kidx = kid
                    kc = chunks[kidx]
                    km = re.match(r'^[#.][A-Za-z][A-Za-z0-9_-]*\s+(.+)$', kc["header"])
                    inner_sel = km.group(1)
                    block += "\n"
                    if kc["comment"]:
                        block += "\n".join("  " + l if l.strip() else "" for l in kc["comment"].rstrip("\n").split("\n")) + "\n"
                    block += f'  {inner_sel} {{\n'
                    for l in kc["body"].strip("\n").split("\n"):
                        block += f"    {l.strip()}\n" if l.strip() else "\n"
                    block += "  }\n"
            block += "}\n"
            out_parts.append(block)

    new_text = "\n".join(p.strip("\n") for p in out_parts if p.strip()) + "\n"
    return new_text, len(consumed)


def main():
    total_nested = 0
    for path in sorted(STYLES_DIR.glob("_*.scss")):
        new_text, n = nest_file(path)
        if n:
            path.write_text(new_text, encoding="utf-8")
            print(f"{path.name}: nested {n} rule(s)")
        total_nested += n
    print(f"\nTotal nested: {total_nested}")


if __name__ == "__main__":
    main()
