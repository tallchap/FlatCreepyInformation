# Homepage UX preview

Local design prototype only. Nothing here changes the Next.js homepage, connects to the chat API, or deploys the site.

The default **Refined / Swipe to choose** direction follows the centered chat reference. Earlier A/B/C directions remain available for comparison.

## Preview

From the repository root:

```sh
python3 -m http.server 4783 --bind 127.0.0.1 --directory design/homepage-preview
open http://127.0.0.1:4783
```

Swipe or drag the portraits, tap a neighbor, use the arrow buttons, or focus the picker and use Left/Right/Home/End. All seven people are available, with Sam Altman selected first. Per-speaker drafts and demonstration conversations survive speaker changes. New chat clears the preview sessions. Enter submits, Shift+Enter inserts a newline.

The picker follows the pointer during a drag and settles on release. Short drags return to the current speaker. Cancelled gestures do not change speakers. Vertical touch gestures and pinch zoom remain native. Reduced-motion preferences disable settling and text animations.

## Verify

With the local preview running, use an installed Playwright module (Chromium required):

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright node design/homepage-preview/verify.cjs
```

Or run `node design/homepage-preview/verify.cjs` if Playwright resolves locally. Optional `PREVIEW_URL` and `QA_OUTPUT` variables override the local URL and artifact directory. Default artifacts are saved under `.context/homepage-preview/qa-recordings/swipe/`.

The verifier checks mouse dragging, snap-back, neighboring portrait taps, keyboard wraparound, every speaker selection, draft/conversation preservation, reset, four viewport widths, reduced motion, actual browser touch-event dispatch, cancellation, vertical gestures, image loading, and JavaScript errors. It exits nonzero on failures. Searches are explicitly simulated; no search API is called. There is no feedback-learning loop in this UX prototype.

Portrait provenance is recorded in `assets/sources.json`; production image attribution/licensing should be finalized before using these prototype assets on the live site. Existing brand artwork is copied from this repository. Fonts load from Google Fonts with system fallbacks.
