# Astra clip processing

The two generated review queues are `.context/astra-clips/01-ready-clips.md` (1,116 media-available candidates) and `02-recheck-clips.md` (528 additional media-available candidates). Run `python scripts/relevance/prepare_astra.py` to regenerate from the immutable audit. Each candidate includes five minutes of transcript before and after the proposed passage, where available. Queue files are portable editorial inputs; process bounded groups and checkpoint one decision per candidate.

1. Astra reads a candidate and returns the contract in `astra-review-contract.md`. Save the exact JSON. A batch array must be split into one file per candidate before processing. Retain rejected and unresolved decisions in a coverage ledger; neither renders. Candidates with `source_resolution_required` are excluded at the user’s instruction.
2. Validate with `python scripts/relevance/process_astra.py validate --recipe RECIPE.json`. Default paths use the local audit and packets. For another machine, pass `--packets`, `--audit-run`, and `--culled` explicitly. Do not transfer credentials in job bundles. Source snapshots must retain their original input hashes.
3. Render with the same arguments and `render` instead of `validate`. FFmpeg seeks through generation-pinned HTTP ranges. It re-encodes the specified source intervals at native aspect ratio and 1× speed. Read the transfer receipt even on failure. There is no automatic full-video fallback. Existing successful output is hash-checked and reused.
4. Verify the rendered picture, audible dialogue from every intended speaker, complete opening/closing thoughts, duration, and all joins. Local Whisper can provide independent rendered-audio transcription. Caption timing is evidence, not ground truth. If a boundary fails, revise the recipe explicitly and re-render; never silently alter the recipe or assert that unperformed checks passed.
5. Write a final QA JSON bound to the actual MP4 SHA-256 and `audit.digest(recipe)`, with `passed: true` only after verification and checks `picture_verified`, `dialogue_verified`, `boundaries_verified`, `duration_verified` all true. Include evidence paths and review limitations. The renderer's `result.recipe_hash` also incorporates source generation/encoding and is a different identifier: do not substitute it for `audit.digest(recipe)`.
6. Publish using `python scripts/relevance/publish_astra.py --recipe RECIPE.json --media clip.mp4 --qa final-qa.json --out published.json`. This uploads one immutable GCS object and merges one `provider=astra` row into `reptranscripts.snippets_auto`. It verifies cloud bytes, public ranged playback, live source membership, the historical cull exclusion, and database readback. Repeating the command must yield the same object generation and single database row.
7. Keep the recipe, render receipt, QA evidence and publication receipt together. A review decision is not a rendered clip; a rendered clip is not a published database record. Report each stage separately.

The current authorization covers the initial one-clip then two-clip workflow and its expansion to five videos with repeated finalizer/verifier experiments, followed by twenty additional calibration clips in two waves of ten with independent Astra review. It does not start production processing of the 1,644 media-available candidates. The 915 culled IDs are forbidden in both editorial and media consumers.

## Cost accounting

Count source HTTP response bytes, range-response upper bounds, number of read requests, output bytes, runtime and database query charges. Response bytes consumed are a measurement of application reads, not a cloud invoice; server/socket read-ahead can exceed them. Include repeated attempts in total pilot spend and distinguish them from the steady-state ten-clip estimate. Already-cached sources incur no new GCS source download. FFmpeg and local Whisper have no per-call fee; the existing Shadow subscription and agent subscription are separate fixed costs.

For US multi-region Standard storage, published rates checked 2026-09-30: ordinary internet egress to US/Europe $0.12/GiB at the first tier, uploads free, replication writes $0.02/GiB, storage approximately $0.026/GiB/month, Class A $0.01/1,000 operations and Class B $0.0004/1,000. Do not assume unused free quotas. Other destinations and billing tiers differ. Playback downloads add egress. Source: https://cloud.google.com/storage/pricing

## Automated finalizer/verifier loop

After the editorial recipe is rendered, run the Luna handoff over groups of up to eight clips. Two independent model calls have separate responsibilities: Finalizer returns keep/trim instructions; Verifier judges the current rendered result. Feed verifier failure reasons back for the next round. A maximum of five rounds per clip prevents endless revisions. Unresolved clips produce an Astra handoff with the original recipe, source and media hashes, all decisions and current media evidence; they are not completed or published.

Local transcription and sampled frames replace routine interactive inspection. This is automated evidence-based QA, not a claim that a human listened or every frame was visually inspected. FFmpeg still decodes the full clip for technical errors. Local trims use already-downloaded media, so revisions do not trigger more GCS source traffic. Cache model requests by exact evidence hashes so rerunning an unchanged handoff does not pay for the same call again. Price receipts include cached input, cache writes and output usage.

### Running the finalizer/verifier handoff

```bash
.context/relevance-venv/bin/python scripts/relevance/luna_batch_qa.py pipeline \
  --clips /path/to/rendered-clip-1 /path/to/rendered-clip-2 \
  --packets .context/astra-clips/candidates \
  --output .context/astra-clips/luna-qa \
  --run-id production-batch-001
```

Use one to eight render directories per batch. Each has `clip.mp4`, `recipe.json`, `result.json`, and technical `qa.json` from the renderer. Missing ASR and contact sheets are generated locally. The default Whisper executable is `/opt/homebrew/bin/whisper`; override `--whisper-cli` for another machine with the same CLI contract. Shadow's separate faster-whisper wrapper needs an adapter before this exact command can use it; this pilot exercised the Mac implementation.

Read `pipeline-results.json`: only `status=pass`, `complete=true` can feed the publisher using its exact `recipe_path`, `media_path`, and neighboring `final-qa.json`. `status=escalated` points to an Astra Markdown/JSON handoff. The tool does not call paid Astra or publish on its own. Within an active Astra session, consume that handoff as the next task; retain unresolved work as incomplete. Finalizer and Verifier are independent Luna Responses calls. The verifier receives the actual updated evidence without the finalizer's approval/reason. Opaque hashes are verified in code and bound through request metadata; Luna only returns clip IDs.

Keep the same run ID to resume cached work without repeated calls. Change it only to request a deliberately fresh, paid experiment. Exact evidence and prompt changes create a new run hash. Interrupted calls without a saved response stop for inspection rather than automatically charging again. Local trims preserve the parent recipe, add ASR provenance and corrected source timing, and fetch zero additional GCS footage.

The current production scope excludes all 362 candidates without known GCS footage. The generated queues therefore contain 1,116 ready candidates and 528 rechecks (1,644 total). No replacement-footage acquisition is requested. The original 2,006 candidate packets remain as audit material; only the two media-available queues define the processing scope.

## Twenty-clip calibration

The fixed calibration manifest selects ten ready and ten review candidates, split into two waves of five per lane. Selection is seeded before inspecting boundaries; available source objects are below 1 GB and previously tested/deferred IDs are excluded. Wave 1 supplies prompt feedback; wave 2 tests the frozen revision on unseen clips. Keep blind Astra verdicts separate from later discrepancy judgments and report exact media/recipe hashes, false approvals, unresolved cases, unnecessary edits, pass counts and costs.

For calibration only, a candidate whose captions cannot establish exact boundaries may have a separate provisional `staging-recipes/` source envelope. This fetches a bounded 15–240-second range so local ASR can supply the missing audio evidence. It is not editorial approval, does not replace the original `needs_context` decision, and is never published merely because it rendered. The paired model loop and independent Astra review must judge the actual rendered content. Preserve all twenty IDs in coverage, including failures.
