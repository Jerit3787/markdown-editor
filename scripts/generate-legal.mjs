// Generates client/public/{privacy,terms}.html from the legal/*.html
// templates, filling the <!--CONTACT--> slot. A support email is shown
// only when SUPPORT_EMAIL is set at build time (Cloudflare build env for
// production; unset for dev / self-host, which then just point at the
// GitHub issues tracker).
//
// Runs as `prebuild` / `predev:client`. The generated files are
// git-ignored — templates in legal/ are the source of truth.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_URL = "https://github.com/Jerit3787/markdown-editor/issues";
const ISSUES_LINK = `<a href="${ISSUES_URL}" target="_blank" rel="noopener">github.com/Jerit3787/markdown-editor</a>`;

/** The inner HTML for the Contact paragraph. */
export function contactHtml(email) {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return `Open an issue at ${ISSUES_LINK}.`;
  const safe = trimmed.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `Email <a href="mailto:${safe}">${safe}</a>, or open an issue at ${ISSUES_LINK}.`;
}

/** Fill the <!--CONTACT--> slot in a template. */
export function applyContact(html, email) {
  return html.replace("<!--CONTACT-->", contactHtml(email));
}

function main() {
  const srcDir = resolve(ROOT, "legal");
  const outDir = resolve(ROOT, "client/public");
  mkdirSync(outDir, { recursive: true });
  const email = process.env.SUPPORT_EMAIL;
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".html"))) {
    const out = applyContact(readFileSync(resolve(srcDir, file), "utf8"), email);
    writeFileSync(resolve(outDir, file), out);
    console.log(`generate-legal: wrote client/public/${file}${email ? " (with support email)" : ""}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
