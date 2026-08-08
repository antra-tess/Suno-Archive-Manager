# SAM - Suno Archive Manager — Browser Extension

Download your entire Suno music library as a local ZIP. No cloud accounts, no console scripts, no external servers.

## What it does

1. Auto-captures your Suno library page as your scroll, intercepting API responses
2. Indexes every song as it loads (live counter in the popup)
3. Exports everything as a ZIP: audio files (MP3/M4A), cover art, and `metadata.json`

## Install

1. Clone the repo
   
## Build

```bash
npm install
npm run build:all        # builds dist/chrome/ and dist/firefox/
npm run build:chrome     # Chrome only
npm run build:firefox    # Firefox only
```

### Package for distribution

```bash
npm run package:chrome   # → dist/archive-master-chrome.zip
npm run package:firefox  # → dist/archive-master-firefox.zip
```

## Load in Chrome (unpacked)

1. Run `npm run build:chrome`
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `dist/chrome/` folder

> Note: This is a manually installed extension. Permanent installation will be available if demand warrants an official release via the Chrome Extension Store).

## Load in Firefox (temporary)

1. Run `npm run build:firefox`
2. Open Firefox → `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…**
4. Select `dist/firefox/manifest.json`

> Note: Temporary add-ons are removed on browser restart. Permanent installation will be available if demand warrants an official release via Mozilla Firefox Addon's Library).

## Usage

Songs are **captured automatically as you browse** suno.com — every page load and
in-app navigation is indexed (the toolbar badge shows the running count). This means
you can visit several playlists one after another and export them all as one archive.

1. Navigate to **suno.com/me** (or any playlist page)
2. Click the SAM icon in your toolbar
3. Click **Scan This Page** — the extension auto-scrolls to the bottom, capturing
   everything the page loads. Scans are *additive*: browse or scan more pages and
   the counter keeps growing. Use **Clear Archive** to start over.
4. When you've collected everything you want, click **Download ZIP** — or
   **Metadata Only (JSON)** for an instant export of just the song data
   (titles, tags, prompts, play/upvote counts, CDN URLs) with no audio files
5. Wait for the ZIP to assemble and download — large libraries are split into
   ~500MB parts and may take a few minutes

## ZIP structure

```
SAM_YYYY-MM-DD/
├── metadata.json          ← song data (title, tags, prompt, play/upvote counts, …)
├── audio/
│   └── song_title_id.mp3  (or .m4a — extension detected from URL)
└── covers/
    └── song_title_id.jpg
```

Large libraries are split into multiple ZIP parts capped at ~500MB each
(`SAM_YYYY-MM-DD_part1.zip`, `_part2.zip`, …). Each part is self-contained and
carries a `metadata.json` for the songs it holds. Small libraries produce a
single unsuffixed ZIP.

## Known limitations

- **CDN URL expiry**: Suno CDN URLs expire after some time. Export promptly after scanning; don't save the JSON and come back days later.
- **Large libraries**: 500+ songs may take several minutes to fetch and assemble. The progress bar shows per-file progress. Exports are split into ~500MB ZIP parts so memory stays bounded regardless of library size.
- **SPA navigation**: If you navigate away and back during a scan, the extension re-attaches automatically, but a page hard-refresh resets the content script state (the background still holds already-captured songs).
- **Firefox temporary installs**: Removed on browser restart — use `about:debugging` each session, or sign via AMO.
- **M4A on older Android**: Some Suno tracks are delivered as `.m4a`. The extension always detects the extension from the URL rather than hardcoding `.mp3`.

## Architecture

| File | Role |
|------|------|
| `src/content/content-script.js` | Patches `window.fetch` (Chrome MAIN world) |
| `src/content/content-script-ff.js` | Injects page-world script via `<script>` tag (Firefox) |
| `src/background/service-worker.js` | Chrome MV3 — stores songs in `session` storage, delegates ZIP to offscreen |
| `src/background/background-page.js` | Firefox MV2 — persistent page, assembles ZIP directly |
| `src/offscreen/offscreen.js` | Chrome only — fetches files and builds ZIP (needs a document context for Blob URLs) |
| `src/popup/` | Vanilla JS popup — 4 states: offsite / ready / scanning / done |
| `src/lib/jszip.min.js` | Bundled JSZip — no CDN calls at runtime |
