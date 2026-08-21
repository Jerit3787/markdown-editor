#!/usr/bin/env python3
# TEMPORARY — used only during the SCSS migration
# (docs/superpowers/plans/2026-08-21-scss-migration.md). Deleted after
# the migration is verified and committed.
#
# Compares two compiled CSS files as a SET of atomic rules rather than
# an ordered diff — splitting a genuinely interleaved source file into
# component partials necessarily reorders some rules relative to each
# other, which is safe by CSS cascade semantics as long as no two
# rules of equal specificity targeting the same element got reordered
# relative to EACH OTHER. This script:
#   1. Flattens both files into atomic (media_condition, selector,
#      declarations) tuples, normalized (whitespace-collapsed) for
#      comparison.
#   2. Reports any atomic rule present in one file but not the other
#      (dropped, duplicated, or content-altered).
#   3. Separately reports the ordered list of (media_condition,
#      selector) pairs for every rule that appears MORE THAN ONCE
#      across the whole file (same selector, multiple separate rule
#      blocks) in each file — these are the only cases where source
#      order could matter, so they need a manual look to confirm the
#      relative order between a selector's own repeated occurrences
#      didn't change in a way that flips which declaration wins.

import re
import sys
from pathlib import Path
from collections import Counter

def normalize_decls(s):
    # Comments carry no behavior; Sass can reattach a nested block's
    # leading comment to the compiled parent rule instead of the
    # nested child during de-nesting (a real, harmless quirk — verified
    # by inspecting compiled output directly), so comment placement
    # must not affect this comparison at all.
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.DOTALL)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def flatten(css_text, media=""):
    """Yield (media, selector, normalized_declarations) for every rule
    in css_text, recursing into @media/@supports blocks. Leading
    comments are skipped entirely (not attached to either the
    preceding or following rule) so a rule's classification and
    boundaries don't depend on incidental comment placement."""
    i = 0
    n = len(css_text)
    while i < n:
        while i < n and css_text[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        if css_text[i:i+2] == "/*":
            end = css_text.find("*/", i + 2)
            i = end + 2 if end != -1 else n
            continue
        if css_text[i] == "@" and css_text[i:i+7] == "@import":
            end = css_text.find(";", i) + 1
            i = end
            continue
        if css_text[i] == "@" and css_text[i:i+8] == "@charset":
            end = css_text.find(";", i) + 1
            i = end
            continue
        brace = css_text.find("{", i)
        if brace == -1:
            break
        header = css_text[i:brace].strip()
        depth = 1
        k = brace + 1
        while k < n and depth > 0:
            if css_text[k] == "{":
                depth += 1
            elif css_text[k] == "}":
                depth -= 1
            k += 1
        body = css_text[brace + 1:k - 1]
        if header.startswith("@media") or header.startswith("@supports"):
            yield from flatten(body, media=(media + " " + header).strip())
        else:
            decl = normalize_decls(body)
            # A rule with no declarations (after stripping comments) has
            # zero effect on rendering by definition — Sass can leave one
            # of these behind when a nested block's only content was a
            # leading comment that got reattached to the compiled parent
            # during de-nesting (same harmless quirk normalize_decls
            # already accounts for; this is its rule-count-level version).
            if decl:
                yield (media, header, decl)
        i = k

def load(path):
    text = Path(path).read_text(encoding="utf-8")
    return list(flatten(text))

def main():
    if len(sys.argv) != 3:
        print("usage: compare-scss-output.py <baseline.css> <current.css>", file=sys.stderr)
        sys.exit(2)
    baseline_rules = load(sys.argv[1])
    current_rules = load(sys.argv[2])

    baseline_set = Counter(baseline_rules)
    current_set = Counter(current_rules)

    missing = baseline_set - current_set   # in baseline, not in current
    extra = current_set - baseline_set     # in current, not in baseline

    ok = True
    if missing:
        ok = False
        print(f"MISSING from new output ({sum(missing.values())} rule(s)):", file=sys.stderr)
        for (media, sel, decl), count in missing.items():
            print(f"  x{count}  media={media!r} selector={sel!r}", file=sys.stderr)
            print(f"        {decl[:200]}", file=sys.stderr)
    if extra:
        ok = False
        print(f"EXTRA in new output, not in baseline ({sum(extra.values())} rule(s)):", file=sys.stderr)
        for (media, sel, decl), count in extra.items():
            print(f"  x{count}  media={media!r} selector={sel!r}", file=sys.stderr)
            print(f"        {decl[:200]}", file=sys.stderr)

    if not ok:
        sys.exit(1)

    print(f"SET MATCH: {len(baseline_rules)} rules in baseline, {len(current_rules)} in current — identical as a set.")

    # Report repeated selectors (same media+selector appearing >1x) in
    # each file, and flag if their relative order changed.
    def repeated_order(rules):
        seen = {}
        order = {}
        for idx, (media, sel, decl) in enumerate(rules):
            key = (media, sel)
            seen.setdefault(key, []).append(idx)
        return {k: v for k, v in seen.items() if len(v) > 1}

    b_repeats = repeated_order(baseline_rules)
    c_repeats = repeated_order(current_rules)
    flagged = []
    for key in b_repeats:
        if key not in c_repeats:
            continue
        # Compare relative order of this selector's own occurrences against
        # each OTHER repeated selector it could conflict with — approximate
        # by just printing repeats for manual review, since true conflict
        # detection needs specificity comparison, which is a manual call.
        flagged.append(key)

    if flagged:
        print(f"\n{len(flagged)} selector(s) appear more than once — manual review recommended", file=sys.stderr)
        print("(same selector defined in multiple separate rule blocks; source order between", file=sys.stderr)
        print("them determines which wins for any overlapping property):", file=sys.stderr)
        for media, sel in flagged:
            print(f"  media={media!r} selector={sel!r}  (baseline order: {b_repeats[(media, sel)]}, current order: {c_repeats[(media, sel)]})", file=sys.stderr)

if __name__ == "__main__":
    main()
