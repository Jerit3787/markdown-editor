# Dedicated Marketing Homepage (`/home`) — Design Spec

**Status:** Approved (brainstorm 2026-09-11)  
**Target URL:** `https://editor.danplace.tech/home`  
**Purpose:** Provide an unambiguous, public-facing, static marketing homepage that fulfills Google Trust & Safety OAuth verification criteria (app branding, purpose description, public access, no login wall, and prominent legal links).

---

## 1. Problem Statement & Motivation

During Google OAuth verification for the `https://www.googleapis.com/auth/drive.file` scope, Google Trust & Safety flagged:
1. *Your homepage is behind a login page.*
2. *Your homepage does not explain the purpose of your app.*
3. *The app name 'Markdown Editor' configured for your OAuth consent screen does not match the app name on your homepage.*
4. *Your privacy policy page at 'https://editor.danplace.tech/privacy' does not have sufficient content.*

While PR #229 resolved the privacy policy disclosures and empty-state in-app copy, the root URL (`/`) remains a full Single Page Application (SPA). To automated crawlers and manual review teams, an SPA shell can appear as an interactive tool or login gate rather than a conventional, transparent marketing homepage.

### Solution
Deploy a dedicated, fast, static marketing homepage at **`https://editor.danplace.tech/home`** (served at `/home`) that:
- Prominently showcases the exact app name (**Markdown Editor**) in an `<h1>`.
- Explains the complete purpose and capabilities of the application.
- Has zero login requirements or barriers to view all information.
- Dedicates a section to Google Drive integration transparency and user data safety.
- Prominently links to the Privacy Policy (`/privacy`), Terms of Service (`/terms`), and GitHub.
- Provides a high-contrast **"Launch Editor"** button linking directly to the app at `/`.
- Is configured as the official **Application home page** in Google Cloud Console.

---

## 2. Page Architecture & Routing

### 2.1 Static Asset Serving
- Source file: `client/public/home.html`.
- During build (`npm run build`), Vite copies `client/public/home.html` directly into `client/dist/home.html`.
- Cloudflare Pages / Workers asset handling maps clean URL `/home` directly to `home.html` (identical to `/privacy` and `/terms`).

### 2.2 Content Security Policy (CSP)
- In `src/worker.ts`, requests to `/home` receive the static/legal CSP policy (`legalCsp(nonce)` or equivalent minimal CSP) which enforces:
  - `default-src 'none'`
  - `script-src 'nonce-<nonce>'`
  - `style-src 'unsafe-inline'`
  - `img-src 'self' data:`
  - `font-src 'self' data:`
  - `base-uri 'self'`
  - `form-action 'none'`
- This guarantees zero external script dependencies, instant edge delivery, and full compliance with CSP standards.

---

## 3. Page Layout & Content Structure

### 3.1 Header (Sticky Navigation)
- **Brand**: Logo icon (`/logo.svg`, 36x36) + bold title `Markdown Editor`.
- **Navigation Links**:
  - `Features` (`#features`)
  - `Google Drive` (`#google-drive`)
  - `Privacy` (`/privacy`)
  - `Terms` (`/terms`)
- **Primary CTA**: Button `Launch Editor` (styled as a high-contrast primary button, linking to `/`).

### 3.2 Hero Section
- **Badge**: `Free & Open Source • 100% In-Browser`
- **Main Heading**: `<h1>Markdown Editor</h1>`
- **Subheading**: `The Fast, Private, In-Browser Markdown Workspace`
- **Lead Copy**:
  > Write, preview, and collaborate in real-time. Free, open source, and runs entirely in your browser — your notes stay on your machine, with optional cloud sync to Google Drive and GitHub. No account or login required.
- **Action Buttons**:
  - `Launch Editor — It's Free` (Primary CTA, links to `/`)
  - `View on GitHub` (Secondary button, links to `https://github.com/Jerit3787/markdown-editor`)
- **Visual Mockup**:
  - A stylized browser window preview showing side-by-side editing:
    - Left: Markdown source with headers, lists, KaTeX math formula, and Mermaid diagram code.
    - Right: Rendered output with formatted typography, math formula rendering, and a diagram.

### 3.3 Core Capabilities Grid (`#features`)
A responsive 3-column grid of feature cards:
1. **Live Preview & Rich Formatting**  
   Instant side-by-side preview with GitHub Flavored Markdown, syntax highlighting, KaTeX math typesetting, and Mermaid diagram generation.
2. **100% In-Browser Privacy**  
   Offline-first architecture. Notes are stored locally in your browser’s IndexedDB/localStorage; nothing is transmitted to any central database.
3. **Google Drive Integration**  
   Open, edit, and sync markdown files directly to and from your personal Google Drive with a single click.
4. **GitHub & Gist Sync**  
   Seamlessly browse repositories, open markdown files across branches, and publish revision-tracked Gists.
5. **Real-Time Collaboration**  
   Shareable peer-to-peer rooms with live cursor awareness, tracked suggestions, and inline comment threads.
6. **Flexible Export Options**  
   Export your work anytime to clean Markdown (`.md`), standalone styled HTML, formatted PDF, or raw text.

### 3.4 Google Drive & Data Safety Section (`#google-drive`)
Explicitly structured to satisfy Google Trust & Safety verification questions:
- **Scope Transparency**: Confirms the app requests only `https://www.googleapis.com/auth/drive.file`. The app only ever accesses files the user specifically selects via the Google Picker dialog. It cannot view, edit, or delete any other files in Google Drive.
- **Data Protection**: OAuth tokens are encrypted using AES-256-GCM and stored exclusively in secure, HttpOnly, SameSite cookies. Document contents are processed locally in memory.
- **No-AI & No-Sale Guarantee**: Explicitly guarantees that user data is never sold, never shared with third parties, and never used to train machine learning or AI models.
- **Google API Disclosure**: Standard Google API Services User Data Policy / Limited Use statement.
- **Quick Links**: Direct links to [Privacy Policy](/privacy) and [Terms of Service](/terms).

### 3.5 FAQ Section
Brief accordion / card list answering common user questions:
- *Do I need an account to use Markdown Editor?* No, the editor is immediately accessible without any sign-up.
- *Where are my notes stored?* Notes are stored locally in your browser unless you explicitly connect Google Drive or GitHub.
- *Is it free?* Yes, Markdown Editor is 100% free and open-source.

### 3.6 Footer
- **Branding**: `Markdown Editor` by Dan Place.
- **Links**:
  - `Launch App` (`/`)
  - `Privacy Policy` (`/privacy`)
  - `Terms of Service` (`/terms`)
  - `GitHub Source` (`https://github.com/Jerit3787/markdown-editor`)
  - `Contact Support` (`support@danplace.tech`)

---

## 4. Integration with Existing App

### 4.1 In-App Navigation Links
- **Menu Bar**: In `client/src/components/Menubar.svelte`, add a `Homepage` item under the `Help` menu linking to `/home`.
- **Empty State Footer**: In `client/index.html`, add `<a href="/home">Homepage</a>` alongside the existing `/privacy` and `/terms` links in both empty-state variants.
- **Legal Pages Navigation**: In `legal/privacy.html` and `legal/terms.html`, update the header navigation to include `Home` (`/home`) alongside `Back to Editor` (`/`).

---

## 5. Google Cloud Console Verification Setup

Update the Google Cloud Console OAuth consent screen:
1. **Application home page**: `https://editor.danplace.tech/home`
2. **Application privacy policy link**: `https://editor.danplace.tech/privacy`
3. **Application terms of service link**: `https://editor.danplace.tech/terms`
4. **App name**: `Markdown Editor`
5. **Support email**: `support@danplace.tech`

Update `docs/GOOGLE-OAUTH-VERIFICATION.md` to reflect `https://editor.danplace.tech/home` as the official homepage URL.

---

## 6. Verification & Testing

- **Static Generation**: `npm run build` succeeds and produces `client/dist/home.html`.
- **Worker CSP**: `tests/src/csp.test.ts` updated to verify `/home` receives the correct nonced CSP policy.
- **E2E Test**: New Playwright spec `tests/e2e/local/homepage.spec.ts`:
  - Validates `GET /home` returns 200 OK.
  - Confirms `h1` contains `Markdown Editor`.
  - Confirms "Launch Editor" button links to `/`.
  - Confirms Privacy Policy and Terms of Service links exist and function.
  - Confirms responsive layout on mobile viewport.
