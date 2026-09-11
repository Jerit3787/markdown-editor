# Google OAuth Verification Handbook

This guide outlines the exact requirements and step-by-step instructions to successfully submit and pass Google OAuth Verification for **Markdown Editor**, specifically addressing the issues flagged in previous verification attempts.

---

## 1. Summary of Previous Issues & How They Were Fixed

| Google Rejection Finding | Root Cause | Fix Applied |
| :--- | :--- | :--- |
| **Privacy policy at `/privacy` does not have sufficient content** | Section 6 previously stated: *"Google Drive — not yet available. A Google Drive integration is planned but not currently part of the app..."* | Overhauled Section 6 to detail active `drive.file` usage, data storage (AES-256-GCM tokens in HttpOnly cookies; local-only document storage; no server storage), no-AI training guarantee, and the mandatory **Google API Services User Data Policy / Limited Use** disclosure. |
| **Homepage is behind a login page** | First-time visitors landing on the SPA app were greeted by workspace creation buttons or an interactive editor shell, which review bots and manual reviewers often misclassify as an unauthenticated login gate. | Created a dedicated, public-facing static marketing homepage at **`https://editor.danplace.tech/home`** with zero login barriers, fully accessible to review bots and human reviewers. |
| **Homepage does not explain the purpose of your app** | The app shell previously lacked a dedicated, full marketing presentation of Markdown Editor's features, tools, and integrations. | Added comprehensive hero copy, 6-card feature grid, and a dedicated Google Drive & Data Safety section on `/home` explaining the app's purpose in full detail. |
| **App name 'Markdown Editor' does not match homepage** | The consent screen is configured with `Markdown Editor`, but root SPA states showed contextual document/workspace headings. | The dedicated homepage at `/home` prominently displays `<h1>Markdown Editor</h1>` in the hero and header. |
| **Support Email (`support+markdowneditor@danplace.tech`)** | Plus-addressed emails (`+...`) frequently trigger automated format rejections in Google's verification system or bounce. | Configured the clean exact address **`support@danplace.tech`** (no `+` alias) across privacy policy, terms, and consent screen. |

---

## 2. Google Cloud Console Configuration (Field-by-Field)

Navigate to **Google Cloud Console** → **APIs & Services** → **OAuth consent screen**.

### Page 1: OAuth Consent Screen Details

- **User Type**: External
- **App name**: `Markdown Editor`
  *(Must match the heading on https://editor.danplace.tech/home exactly)*
- **User support email**: Select `support@danplace.tech` (or your Google account email `danish.hakim04@gmail.com` if using Gmail)
- **App logo** *(Optional)*:
  - *Recommendation*: **Leave blank** unless necessary. Uploading a logo triggers additional brand and trademark verification by Google Trust & Safety, which increases review delays.
- **Application home page**: `https://editor.danplace.tech/home`
  > [!TIP]
  > Using the dedicated static marketing homepage at `https://editor.danplace.tech/home` ensures Google Trust & Safety reviewers and automated screeners see a 100% public, informative landing page that immediately passes all homepage review criteria.
- **Application privacy policy link**: `https://editor.danplace.tech/privacy`
- **Application terms of service link**: `https://editor.danplace.tech/terms`
- **Authorized domains**:
  - Add `danplace.tech`
  *(Ensure `danplace.tech` is verified in [Google Search Console](https://search.google.com/search-console) under the same Google account)*
- **Developer contact information**:
  - `support@danplace.tech` (or `danish.hakim04@gmail.com`)

---

### Page 2: Scopes

Click **Add or Remove Scopes** and add **only**:
- `https://www.googleapis.com/auth/drive.file`

> [!IMPORTANT]
> Do **NOT** request `.../auth/drive` or `.../auth/drive.readonly`. The `drive.file` scope is a sensitive, non-restricted scope that does not require an annual paid third-party CASA security assessment.

---

## 3. Written Scope Justifications (Copy & Paste)

When submitting for verification, Google asks why you need the requested scopes and how they are used. Use the exact text below:

### Field: "How will your app use the requested scopes?"
```text
Markdown Editor (https://editor.danplace.tech) is a client-side Markdown note-taking and editing tool. The app uses the "https://www.googleapis.com/auth/drive.file" scope to allow users to open, view, edit, and save their Markdown documents directly to and from their personal Google Drive.

Using the Google Picker API, users explicitly browse and select individual Markdown files (.md, .txt) from their Google Drive. The app accesses only the specific files selected by the user to display and edit their content in the browser. All document editing and preview rendering happen locally in the user's browser. The application never accesses, reads, or modifies any other files or folders in the user's Google Drive.
```

### Field: "Why can't you use a narrower or non-sensitive scope?"
```text
The "https://www.googleapis.com/auth/drive.file" scope is the narrowest and most privacy-preserving Google Drive scope available for this functionality. It grants access strictly to files that the user explicitly selects via the Google Picker or files created by the application itself. Because our core feature is allowing users to open and save their own existing Markdown notes from Google Drive, accessing the content of user-chosen files via drive.file is strictly required. No narrower scope exists that allows reading and editing user-selected files.
```

---

## 4. YouTube Demo Video Instructions

Google requires a YouTube video demonstrating how your app uses the requested scope. Reviewers strictly follow a checklist when watching this video:

### Video Requirements Checklist:
1. **Address Bar Visibility (CRITICAL)**: The browser URL bar must be clearly visible throughout the entire recording, especially when the OAuth popup opens, showing the `client_id` parameter (e.g. `...accounts.google.com/o/oauth2/v2/auth?...client_id=...`).
2. **App Branding**: The name "Markdown Editor" and URL `https://editor.danplace.tech` must be visible on the homepage.
3. **Demonstrate User-Initiated OAuth**:
   - Start on `https://editor.danplace.tech`.
   - Click **Settings** (gear icon) → Connections → **Connect Google Drive** (or File → Open → Markdown from Google Drive).
   - Show the Google OAuth popup appearing.
   - Zoom in or pause briefly so the reviewer can clearly read the OAuth client ID in the URL bar.
   - Complete the sign-in / consent step showing the permissions requested.
4. **Demonstrate Scope Usage**:
   - Show the Google Picker appearing.
   - Select a sample Markdown file (e.g. `sample-notes.md`).
   - Show the file loading into Markdown Editor with live preview.
   - Make a minor edit to the text in the editor to demonstrate active usage.
5. **Language & Privacy Settings**:
   - English audio commentary or English subtitles/captions explaining what is happening.
   - Upload the video to YouTube as **Unlisted** (or Public). Do **NOT** set it to Private.

---

## 5. Pre-Submission Verification Checklist

Before clicking **Submit for Verification** in Google Cloud Console:

- [ ] Deploy the latest changes to Cloudflare:
  ```bash
  npm run build
  npx wrangler deploy
  ```
- [ ] Visit `https://editor.danplace.tech/home` in an **Incognito / Private Window**:
  - Verify that `<h1>Markdown Editor</h1>` is prominently displayed in the hero section.
  - Verify the tagline explaining the app's purpose is visible.
  - Verify the 6-card feature grid and Google Drive transparency section are rendered.
  - Verify the "Launch Editor" button links to `/`.
  - Verify the footer links to `/privacy` and `/terms` are clickable.
- [ ] Visit `https://editor.danplace.tech/privacy`:
  - Confirm Section 6 lists "Google Drive integration" with `https://www.googleapis.com/auth/drive.file`.
  - Confirm the Google API Services User Data Policy / Limited Use statement is present.
  - Confirm Section 11 shows `Email support@danplace.tech...`.
- [ ] Test the email `support@danplace.tech`:
  - Send a test email from an external account (e.g. personal Gmail) to `support@danplace.tech` and confirm it arrives in your iCloud Mail inbox.
- [ ] Verify domain in Google Search Console:
  - In [Google Search Console](https://search.google.com/search-console), confirm that `danplace.tech` has a green checkmark under the same Google account.
- [ ] Record and upload your YouTube demo video as **Unlisted**, copy the link, and paste it into the verification form.
