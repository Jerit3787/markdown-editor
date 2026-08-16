#!/usr/bin/env bash
# Reverts enable-dev-login.sh's change to src/worker.ts. Run this before
# any git add/commit that touches src/worker.ts, and always before
# wrapping up a local-testing session.
set -euo pipefail
cd "$(dirname "$0")/../.."

if grep -q "DEV_LOGIN_PATH" src/worker.ts 2>/dev/null; then
  git apply -R scripts/manual-testing/dev-login.patch
  echo "Removed dev-login route from src/worker.ts."
else
  echo "src/worker.ts has no dev-login route applied — nothing to do."
fi

if git diff --quiet -- src/worker.ts; then
  echo "src/worker.ts is clean (matches HEAD)."
else
  echo "WARNING: src/worker.ts still has uncommitted changes — check 'git diff -- src/worker.ts' before committing anything." >&2
fi
