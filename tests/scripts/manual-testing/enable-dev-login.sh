#!/usr/bin/env bash
# Applies the local-only /api/dev/login route to src/worker.ts so the
# scripts in this directory can sign in without real GitHub OAuth. Never
# commit the result — run disable-dev-login.sh before finishing (and
# before any `git add`/`git commit` touching src/worker.ts).
set -euo pipefail
cd "$(dirname "$0")/../../.."

if git diff --quiet -- src/worker.ts && ! grep -q "DEV_LOGIN_PATH" src/worker.ts; then
  git apply tests/scripts/manual-testing/dev-login.patch
  echo "Applied dev-login route to src/worker.ts (uncommitted — remember to run disable-dev-login.sh)."
else
  echo "src/worker.ts already has local changes or the dev-login route already applied — not touching it. Check 'git diff -- src/worker.ts'." >&2
  exit 1
fi

if [ ! -f .dev.vars ]; then
  echo "SESSION_SECRET=local-test-secret-do-not-use-in-prod" > .dev.vars
  echo "Created .dev.vars with a local-only SESSION_SECRET (gitignored)."
fi

echo "Now: npm run build && npm run dev"
