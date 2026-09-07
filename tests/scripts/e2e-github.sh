#!/usr/bin/env bash
# Opt-in real-GitHub e2e suite (GIST-11 / REPO-19 / REPO-22). Needs a
# throwaway account's classic PAT + fixture ids — see
# tests/e2e/github/README.md. Skips cleanly (exit 0) when unconfigured, so
# it is safe to run anywhere.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Allow running locally straight from .dev.vars.
if [ -z "${TEST_GITHUB_TOKEN:-}" ] && [ -f .dev.vars ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.dev.vars
  set +a
fi

if [ -z "${TEST_GITHUB_TOKEN:-}" ]; then
  echo "e2e-github: TEST_GITHUB_TOKEN not set (see tests/e2e/github/README.md) — skipping." >&2
  exit 0
fi
: "${TEST_GITHUB_USERNAME:?set TEST_GITHUB_USERNAME}"
: "${TEST_GITHUB_GIST_ID:?set TEST_GITHUB_GIST_ID}"
: "${TEST_GITHUB_REPO:?set TEST_GITHUB_REPO (owner/name)}"

bash tests/scripts/manual-testing/enable-dev-login.sh

# wrangler dev reads .dev.vars — make sure the Worker sees
# env.TEST_GITHUB_TOKEN / _USERNAME, then strip what we added on exit.
APPENDED=0
if ! grep -q '^TEST_GITHUB_TOKEN=' .dev.vars 2>/dev/null; then
  {
    echo "TEST_GITHUB_TOKEN=$TEST_GITHUB_TOKEN"
    echo "TEST_GITHUB_USERNAME=$TEST_GITHUB_USERNAME"
  } >> .dev.vars
  APPENDED=1
fi

npm run build
npx wrangler dev --local-upstream localhost:8787 &
WRANGLER_PID=$!

cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  # Killing $WRANGLER_PID alone can leave the workerd runtime squatting on
  # :8787 (see e2e-collab.sh's own note) — kill whatever holds the port.
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  if [ "$APPENDED" = "1" ]; then
    grep -v '^TEST_GITHUB_' .dev.vars > .dev.vars.tmp && mv .dev.vars.tmp .dev.vars || true
  fi
  bash tests/scripts/manual-testing/disable-dev-login.sh
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 60); do
  if curl -sf http://localhost:8787 >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "wrangler dev never became ready on :8787 after 60s" >&2
  exit 1
fi

TEST_GITHUB_GIST_ID="$TEST_GITHUB_GIST_ID" \
  TEST_GITHUB_USERNAME="$TEST_GITHUB_USERNAME" \
  TEST_GITHUB_REPO="$TEST_GITHUB_REPO" \
  npx playwright test --project=github --workers=1
