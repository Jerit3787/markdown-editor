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
- Collaboration access control (`src/collab-room.ts`) — who can join a
  shared room and with what role
- Output sanitization (rendered markdown/HTML, PDF export)
