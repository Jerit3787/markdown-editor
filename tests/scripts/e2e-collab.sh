#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

bash tests/scripts/manual-testing/enable-dev-login.sh
trap 'bash tests/scripts/manual-testing/disable-dev-login.sh' EXIT

npm run build
npx wrangler dev --local-upstream localhost:8787 &
WRANGLER_PID=$!
# Killing $WRANGLER_PID alone isn't enough — that's the `npx`/wrangler-CLI
# wrapper, not the actual workerd runtime process it spawns underneath,
# so the real server can survive that kill and keep squatting on :8787
# (confirmed live: this orphaned a workerd process across runs, which
# then made a *later*, unrelated wrangler instance silently fall back to
# :8788 instead — the actual bug behind an earlier port-mismatch red
# herring while building this script). Killing whatever is actually
# bound to the port is the reliable way to reach it regardless of the
# CLI's own process-tree shape.
cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 2>/dev/null || true
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

# --workers=1: every collab test drives the SAME `wrangler dev` on :8787
# (one workerd, shared Durable Object storage) — there is no per-test
# backend isolation, so running them in parallel is pure contention, not
# speed. On GitHub Actions' shared runners that contention starved the
# room's Yjs sync / MESSAGE_WORKSPACE_META broadcasts past the tests' own
# poll windows, failing the sync-heavy specs (doc-created-mid-session,
# second-doc-content, suggestion round-trip) on 3 consecutive PRs that
# never touched collab code, each green on a plain rerun. Serial is both
# correct (shared mutable backend) and stable.
npx playwright test --project=collab --workers=1
