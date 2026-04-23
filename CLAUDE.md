# FlatCreepyInformation — project-level rules

## Visual parity tests use an independent Claude API reviewer

When running Snippy preview-vs-render smoke tests (or any test where you need
to confirm visual correctness across two rendering paths), **never self-certify
from pixel measurements alone**. You have a pixel-counting bias — measurements
can prove positions match without catching "boxes aren't actually flush with
the edge" or "text isn't centered." Always send the rendered image(s) to the
Claude API as an independent reviewer and take its verdict seriously.

### How
Use `qa-recordings/snippy-smoke-2026-04-22/review-image.mjs` (or equivalent
script at the same shape) — POST the PNG to `https://api.anthropic.com/v1/messages`
with `model: claude-opus-4-7`, ask yes/no questions with the specific geometric
claim ("is the rectangle's top-left corner exactly at (0,0)?", "is the text
centered horizontally in the rectangle?"), and end with a `PASS`/`FAIL` verdict.

### Rules for parity runs
- Run the reviewer on BOTH the preview image and the render image.
- Report the verdicts back to the user verbatim, including specific FAIL
  reasons. Do NOT "explain away" a FAIL — if the reviewer says text is shifted
  left, that's the state of the world until the composition is actually fixed.
- If preview and render both FAIL the same way, that's a composition-design bug
  (fix the composition). If only one FAILs, that's a parity bug (fix the
  rendering pipeline).
- Distinguish **precision** (preview == render) from **accuracy** (render
  matches the specified geometric intent). Both must pass before calling a
  parity test done.

### Artifact discipline
Every Snippy parity run should produce these in its `qa-recordings/` folder:
- `inputs.json` — exact composition inputs (byte-identical to harness page)
- `snippy-corners.mp4` — render output
- `render-corners.png` — frame extracted at t=1.5s
- `preview-corners.png` — headless Chrome capture of the harness page iframe
- `sidebyside.png`, `sidebyside-tl.png`, `sidebyside-br.png` — visual diffs

## Snippy composition — overlay anchor semantics

`OverlaySettings.anchor` picks which corner of the overlay sits at
`(xPct, yPct)`: `"top-left"`, `"top-right"`, `"bottom-left"`, `"bottom-right"`.
Default is `"bottom-left"` (legacy). Use `"top-left"` with `xPct=0, yPct=0` to
flush an overlay to the top-left corner of the frame; use `"bottom-right"` with
`xPct=1, yPct=1` for the bottom-right corner.
