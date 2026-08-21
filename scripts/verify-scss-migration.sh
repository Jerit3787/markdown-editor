#!/usr/bin/env bash
# TEMPORARY — used only during the SCSS migration
# (docs/superpowers/plans/2026-08-21-scss-migration.md). Deleted in that
# plan's final task. Compiles client/src/style.scss, normalizes it
# through Prettier so formatting differences don't create false-positive
# diffs, and compares against the fixed baseline captured once at the
# start of the migration (BASELINE_FILE) — every task's compiled output
# must match this same baseline, not the previous task's output, so a
# mistake anywhere is caught immediately rather than silently
# compounding.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE="/tmp/scss-migration-baseline.css"
CURRENT_FILE="/tmp/scss-migration-current.css"

npx sass --no-source-map --style=expanded client/src/style.scss | npx prettier --parser css > "$CURRENT_FILE"

if [ "${1:-}" = "--save-baseline" ]; then
  cp "$CURRENT_FILE" "$BASELINE_FILE"
  echo "Baseline saved to $BASELINE_FILE"
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "No baseline found at $BASELINE_FILE — run with --save-baseline first." >&2
  exit 1
fi

if diff -q "$BASELINE_FILE" "$CURRENT_FILE" > /dev/null; then
  echo "MATCH: compiled output is identical to the baseline."
else
  echo "MISMATCH: compiled output differs from the baseline." >&2
  diff "$BASELINE_FILE" "$CURRENT_FILE" || true
  exit 1
fi
