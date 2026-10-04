# Snippy corpus relevance audit

Assess the full stored transcript of each Snippy video for a self-contained,
clip-worthy 15–240-second AI passage. Source data is read-only. Results are local
CSV/JSON files and an offline searchable HTML report; no production records are
updated or deleted.

The original `snippy-triage-v1.txt` is copied byte-for-byte from
`tallchap/snippy-daily-clips@1303f5d`, path
`config/prompts/triage/snippy-triage-v1.txt`. The separately versioned
`audit-addendum-v1.txt` implements Ori's September 30 clarification: distinguish
absence of a good passage from rejection based on derivative source status.

Automatic preservation precedes every model call. Sam Altman, Dario Amodei,
Demis Hassabis, Eliezer Yudkowsky, Max Tegmark, Yoshua Bengio, Yann LeCun,
Geoffrey Hinton, Nate Soares, Elon Musk, and Connor Leahy are matched in speaker metadata, title, and channel, including multi-speaker records
and Le Cun spelling. Title-only mentions are conservatively preserved, even if
they refer to someone being discussed. Jack Altman, Daniela Amodei, and Samy Bengio
alone do not match. If Luna identifies a protected speaker absent from metadata,
that video is also preserved. Metadata may be imperfect; no automated matching
can guarantee all unlabelled appearances are recognized.

## Run

From the repository root:

```sh
python3 -m venv .context/relevance-venv
.context/relevance-venv/bin/pip install -r scripts/relevance/requirements.txt
.context/relevance-venv/bin/python -m unittest discover -s scripts/relevance -v
.context/relevance-venv/bin/python scripts/relevance/audit.py snapshot
.context/relevance-venv/bin/python scripts/relevance/audit.py run --workers 12
.context/relevance-venv/bin/python scripts/relevance/audit.py verify
open .context/relevance/report.html
```

Use `run --limit 6` for a pilot; rerunning resumes. An existing snapshot is reused.
Use a fresh `--run-dir` for a fresh source snapshot. Credentials come from
`GOOGLE_APPLICATION_CREDENTIALS` (default local service account path) and
`OPENAI_API_KEY` (fallback `~/.config/snippy/snippy.env`). Secrets are never stored
in audit outputs.

The query deduplicates video IDs, combines speaker metadata, and deduplicates
segments by `(video_id,start_sec,text)`, matching the app's transcript reader.
Every complete transcript is sent without truncation. The model is `gpt-6-luna`,
with default reasoning and strict JSON output. Paid responses are cached by a
hash of the full request; raw responses and usage remain on disk. Failed requests
are reported and cause the verifier to exit nonzero. Missing transcripts abstain.
Quote verification checks whitespace-normalized verbatim text and approximate
passage timing (five-second caption tolerance), without changing model text.
It does not certify spoken audio, clean edit boundaries, or source identity.

## Outputs under `.context/relevance/`

- **`no-clipworthy-passage.csv`**: requested rejection list; model explicitly found
  no qualifying passage. Protected, missing, failed, and pending videos excluded.
- `eligible-clips.csv`: original-source eligible passages with passing text checks.
- `needs-review.csv`: positive model judgments with quote/timing discrepancies,
  missing transcripts, or API errors. These are not negative judgments.
- `preserved.csv`: protected speakers, untouched by the filter.
- `all-videos.csv`: complete coverage, also including derivative sources with good
  passages (status `not_eligible`).
- `report.html`: offline viewer, defaults to the requested no-passage list.
- `snapshot.json`, `summary.json`, `verification.json`: source, costs, coverage,
  and a machine-readable verification checklist.
- `inputs.jsonl`, `results/`, `responses/`: immutable source snapshot, per-video
  judgments, and original API responses. These local files are gitignored by
  Conductor's `.context` rule.

Luna judgments are triage, not human-reviewed ground truth. The original prompt
was an uncalibrated first-pass candidate prompt. No arbitrary score threshold is
added; the model judges whether a passage is worth clipping. The feedback loop
for the Daily Clips product is outside this one-time audit's scope.

## Explicitly authorized 915-video cull (September 30, 2026)

`cull.py` is a separate, destructive workflow tied to this exact approved list.
It archives the full original rows in permanent BigQuery tables under
`youtubetranscripts-429803.snippy_history.cull_20260930_*`, exports individual
metadata JSON and complete timestamped transcripts locally, and checks exact
row multiplicity and transcript hashes before allowing deletion. The archive
contains text and structured metadata only: no footage or audio downloads.

Stages: `archive`, `export`, `vector-plan`, `delete-database`, `detach-vectors`,
`verify`, `bundle`. The manifest and all receipts are in
`.context/cull-20260930/`. Vector planning requires complete store and File
metadata inventories there. Conflicting identities, unknown files, and protected
speakers fail closed. Shared-store transcript files are individually identified;
combined speaker files are never guessed or detached wholesale.

The database deletion is one atomic transaction: verify the current rows still
match every archive, delete only the approved IDs, assert every affected count,
then commit. Search cleanup detaches only matching per-video transcript files.
The original OpenAI File objects are text and remain available for restoration.
The verifier checks exact surviving search files, absence of culled IDs in all
20 live tables, unchanged retained metadata, all 1,029 preserved videos present,
and intact permanent archive counts. It exits nonzero on any failure.

Footage in Google Cloud Storage is a separate inventory/deletion operation and
must not be described as removed merely because database/search deletion passed.

`cull_media.py` implements the separately authorized permanent GCS footage cull.
It consumes the reviewed `gcs-delete-plan.json`, refuses unapproved IDs, duplicate
generations, protected speakers, object holds, or already soft-deleted objects.
It verifies the text archive, disables soft delete temporarily with a bucket
metageneration precondition, waits for propagation, deletes exact object
generations, and restores the prior policy in `finally`. Per-object receipts
allow recovery. It never downloads footage. `verify_cull_media.py` compares fresh
inventories for every accessible bucket/project, including old generations and
soft-deleted objects, matching IDs and exact-byte renamed copies. It also proves
non-target generations are unchanged. Inventories are metadata only.

## Production lessons

Read [`PRODUCTION-LESSONS.md`](PRODUCTION-LESSONS.md) before the next production run: Windows PID reuse, Relay recovery, Shadow test-gate and shell limits, failure causes, and the levers on the 44% hold rate, from the frozen-340 run (2026-10-02).
