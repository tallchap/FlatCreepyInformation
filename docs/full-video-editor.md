# Full-video editor verification

Full-video titles, transcript links, and chat/search “Snip It” actions resolve to `/edit?v=VIDEO_ID&start=SECONDS&end=SECONDS`. A timestamp without an end selects ten seconds, clamped to video duration. `/video/VIDEO_ID?t=...` remains a redirect. Legacy `seg=a-b,c-d` bookmarks select the first valid range and display a notice.

The full-video editor previews and exports from YouTube. It supports exactly one Start/End range (1 second–11 minutes); Clip Finder replaces that range. The download-service array payload remains an array of one for compatibility. Existing saved snippets, their pages, and their stored media are unchanged. No database migration or Bunny deletion is part of this change.

Run the pure regression tests with:

```sh
node --test scripts/test-editor-links.mjs
npx tsc --noEmit
npm run build
```

Use the normal application environment for a local server. If its download service points to an inactive local process, set `DOWNLOAD_SERVICE_URL` to the existing service when starting it. Do not run `next dev` and `next build` concurrently against the same `.next` directory.

The browser verifier uses Playwright's Chromium and WebKit engines and **emulates** phones/tablets; it does not certify physical devices:

```sh
PREVIEW_URL=http://localhost:4786 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
node scripts/verify-full-video-editor.cjs
```

It exercises real homepage/chat requests, search, Browse, timestamp handoffs, transcript editing, saved-media playback, legacy bookmarks, keyboard selection, and API rejection of multiple ranges. It invokes paid chat APIs. Only the explicit error-path test and Clip Finder replacement test use injected responses. It never deletes storage or changes database records. `QA_DEVICE` filters test names; `QA_LAYOUT=phone|desktop` repeats a journey at another layout. `QA_OUT` chooses the report directory; the default is `.context/single-clip`.

The script writes screenshots and `workflow-results.json` and exits nonzero on a failed check. This is the repeatable link/workflow verifier; real export files, speech checks, source-frame comparisons, and storage-preservation receipts from the implementation run are recorded separately in `.context/single-clip`.
