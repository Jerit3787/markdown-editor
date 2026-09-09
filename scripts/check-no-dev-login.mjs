// Fails if the local-only dev-login backdoor is present in committed
// source. tests/scripts/manual-testing/enable-dev-login.sh patches
// src/worker.ts with an unauthenticated /api/dev/login session minter
// for manual testing; disable-dev-login.sh reverts it. If a run aborts
// (or someone forgets), that patch could otherwise reach production via
// `npm run deploy`. Runs as `predeploy` and in CI.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NEEDLES = ["/api/dev/login", "DEV_LOGIN_PATH"];
const roots = ["src"];
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (p.endsWith(".ts")) {
      const text = readFileSync(p, "utf8");
      for (const needle of NEEDLES) {
        if (text.includes(needle)) hits.push(`${p} contains "${needle}"`);
      }
    }
  }
}

for (const root of roots) walk(root);

if (hits.length) {
  console.error("Dev-login backdoor detected in committed source:\n  " + hits.join("\n  "));
  console.error("Run: bash tests/scripts/manual-testing/disable-dev-login.sh");
  process.exit(1);
}
console.log("check-no-dev-login: clean");
