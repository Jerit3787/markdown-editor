# Security Policy

## Supported Versions

Only the latest deployed version (see `CHANGELOG.md` for the current
release) is supported. There's no long-term maintenance of older
versions.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security
vulnerabilities.

Instead, report it privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
(Security tab → "Report a vulnerability" on this repository). Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce it
- Any relevant logs, screenshots, or proof-of-concept code

You should receive an acknowledgment within a few days. This is a
small, independently-maintained project — please allow reasonable time
for a fix before any public disclosure.

## Scope

Areas of particular interest given this app's architecture:

- Session/auth handling (`src/auth.ts`, `src/github-auth.ts`) — cookie
  encryption, OAuth flow
- Collaboration access control (`src/workspace-room.ts`, and the legacy
  `src/collab-room.ts`) — who can join a shared workspace/room and with
  what role, and whether a write is actually gated to editors
- GitHub repo sync (`src/github-repo.ts`) — token scope, and whether a
  push/pull can be tricked into touching a repo or path outside the
  linked workspace
- Output sanitization (rendered markdown/HTML, PDF export, print)
