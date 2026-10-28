# Full-video editor verification

Full-video titles, transcript links, and chat/search “Snip It” actions resolve to `/edit?v=VIDEO_ID&start=SECONDS&end=SECONDS`. A timestamp without an end selects ten seconds, clamped to video duration. `/video/VIDEO_ID?t=...` remains a redirect. Legacy `seg=a-b,c-d` bookmarks select the first valid range and display a notice.

The full-video editor previews and exports from YouTube. It supports exactly one Start/End range (1 second–11 minutes); Clip Finder replaces that range. The download-service array payload remains an array of one for compatibility. Existing saved snippets, their pages, and their stored media are unchanged. No database migration or Bunny deletion is part of this change.

The current full-video position appears in a compact timer beside the timeline controls, including hours for long videos. The video has no duplicate timer overlay. The transcript highlights the current spoken line. **Follow playback** scrolls that line into view; switching it off keeps the reader's position. This preference is remembered in the browser. Transcript search temporarily controls scrolling, and clearing the search resumes following when enabled. The desktop side pane matches the natural height of the player and video details; mobile uses a stacked layout.

Ready-made snippets use compact expandable rows with the first snippet open. Each open row has a saved-video player and an always-visible, scrollable transcript pane: side by side with matching heights on desktop, stacked on smaller screens. Opening another row closes the previous player and switches the transcript and download link. A single snippet uses the same layout without duplicate chooser cards. These saved transcripts are plain text, separate from the full-video transcript editor.

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

`scripts/verify-editor-playback.cjs` uses the same `PREVIEW_URL` and `PLAYWRIGHT_MODULE` settings for real playback, current-time readouts, follow on/off, search interaction, preference persistence, keyboard input, fullscreen, and narrow layouts. It covers Chromium, Firefox and WebKit desktop, Android Chromium, and iPhone/iPad WebKit emulation. `QA_DEVICE` selects comma-separated matrix names, and `QA_OUT` selects the evidence directory. It writes `verification.json` and exits nonzero if a check fails; it does not export media or mutate stored videos.

`scripts/verify-ready-made-snippets.cjs` uses the same settings and six configurations for the expandable saved-snippet rows. It checks one and six real snippets, exact transcript/media/download matching, playback, keyboard collapse/reopen, independent transcript scrolling, and responsive alignment. Missing-transcript and empty-list fixtures are injected only in Chromium and identified in the report. Stored media and database records are never changed.
