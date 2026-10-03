# Lessons from the frozen-340 production run (2026-10-01 → 2026-10-02)

What the first full Luna-first production run over a fixed 340-clip subset taught us, with the measured numbers. The run used 49 already-published protected clips plus 291 new ones, on Shadow with root review from the Mac. It is written so the next run avoids the same stalls. Relay jobs: `SNIPPY-291-LUNA-SEVILLE-20261002` (blocked) → `SNIPPY-291-LUNA-RECOVERY-20261002` (DONE, response `R-c0460fbbdd8777fa`).

## Outcome

| | Clips | Share of the 291 |
|---|---|---|
| Published by the run | 143 (+49 protected = 192) | 49% |
| Held for Astra (`awaiting_astra`) | 129 | 44% |
| Failed (terminal in the run) | 19 | 7% |
| Failed, later recovered by a separate Mac retry | 16 of 19 | — |

- **Live in `snippets_auto` afterwards:** 208 of 340. All 192 run publications read back, with no duplicate rows.
- **Final verifier:** passed with 0 errors, out-of-scope records unchanged, no unknown charges.
- **Luna cost for the 291:** about $0.85 ($2.50 cumulative across all attempts).
- **Throughput:** about 0.5–1 clip/min with 2 batch workers, 5 per batch.

**Every one of the 19 failures was operational, not editorial.** The editorial cost is the 44% hold rate.

---

## 1. Process liveness: never trust a bare PID on Windows

**What happened.** Retirement and successor guards checked that old supervisors were dead with `OpenProcess(pid)`. Windows reused those PIDs within minutes for short-lived `git.exe`, `bash.exe`, `grep.exe` and `git-credential-manager.exe` children of Relay traffic. The guards then saw a "live predecessor", which caused:
- 6 false candidate failures;
- 3 production stops;
- an 11-hour stall overnight, until someone read the BLOCKED response.

**Fix (shipped in runtime `ccf00fd`).** A recorded PID blocks only if the live process was **born before** the archived record's observation time. The check uses `GetProcessTimes` on the same handle, with a +1s slack for second-precision receipts. Unknown identity still blocks (fail closed). Confirmed-dead prior compute PIDs are cleared at startup, so `drained()` can't wait on a reused PID (`2394a13`).

**Rule.** Any guard over a PID taken from a receipt must compare creation time with the receipt time. Better still, store the process's own creation time next to its PID and compare for equality.

## 2. A blocked Relay job needs a supported way back in

**What happened.** The supervisor refuses to run unless its Relay job is `CLAIMED`. Once a worker responds BLOCKED and root acknowledges it, the job is terminal, and Relay has no reopen. Resuming the *same* application run (same authorization, plan and root) had no path.

**Fix (`2eba007`).** A corrective Relay job (`relay_job_id`) carries controls, checkpoints, logs and the final response. A hash-pinned recovery receipt keeps the application `job_id`, authorization and plan byte-identical. The supervisor verifies once per process that the predecessor is the acknowledged blocked response (`relay_recovery.py`).

**Rule.** Separate *application identity* from *transport identity* in every long-running runner.

## 3. Shadow operations: things that cost hours

| Problem | Measured | Do this instead |
|---|---|---|
| The full Windows test suite as a launch gate | It hung for 35+ minutes. With the CPU saturated by a concurrent ffmpeg benchmark and Defender at up to 82%, `open()` of fresh temp JSON stalled for 240s or more. The agent died with "milestone log failed". | Gate on the **relevant module set** (14 modules, 236 tests). That took 533s for 215 tests on an idle box and 2860s for 236 under load. The full suite is a Mac job (479 tests, ~55s). |
| Mac test runs | 5 tests fail even on a clean baseline (`/var` vs `/private/var`) | `TMPDIR=/private/tmp/<dir>` |
| The supervisor's hosting shell | Hard 2h lifetime | Do a planned drain cycle about every 1h45m: local PAUSE, clean drain, exit, local RESUME, relaunch. The agent did this on its own at 01:02Z and it cost 4 minutes. Build it in. |
| Executor death | The board still said `CLAIMED`, which looked alive | Check `relay execution status`: `observed` / `process_count` / `recovery_required`. The board status alone is not liveness. |
| Steering | 10–14 minutes from `execution steer` to applied. The default interrupts. | Don't steer an executor that just started. A steer sent to a dead executor fails with "prior process scope is empty", and needs `execution resume` first. |
| Concurrent heavy jobs on Shadow | A 12-batch CPU encode benchmark ran alongside production for about 90 minutes | Lane-level CPU reservation, or at least a board-visible "heavy job running" signal that production checks before launch |
| Relay ack and post from the Mac | `CLAUDE_CODE_SESSION_ID` silently overrides `RELAY_SESSION_FILE` | Set `RELAY_SESSION_PINNED=1` with the origin wallet |
| Origin control lines on a worker-owned job | `relay log` refuses | Use `relay log --force` with the exact text `SNIPPY_CONTROL PAUSE` / `SNIPPY_CONTROL RESUME` |

## 4. Root mistakes worth not repeating

- **Pausing on a misread checkpoint.** `selected-records` in a fixed-subset checkpoint covers **all 340 IDs, including historical records**: Oct-1 `429 Too Many Requests` failures from earlier runs, and stale `awaiting_astra` statuses on 14 of the protected 49 that were published long ago. Root read those as new 429s and paused a healthy run. With `exit_on_pause=true` the supervisor drained and exited 3 seconds before the cancelling RESUME arrived. **Always filter by `scope/continuation-plan.json → remaining_candidate_ids` and cross-check `snippets_auto` before acting on or reporting counts.**
- **Parallel publishers.** A Mac retry published 16 clips while the Shadow supervisor was still publishing. No duplicates resulted, but this breaks the one-publisher invariant. The publisher lock should be enforced across hosts, not by convention.

## 5. Why clips failed, and the fixes upstream

| Cause | Clips | Upstream fix |
|---|---|---|
| PID-reuse false failure (§1) | 6 | Fixed in `ccf00fd` |
| A Luna batch of 5 hit the output-token cap, so the finalizer response came back incomplete and all 5 failed terminally | 5 | Size batches by total clip duration rather than count; isolate long clips (one was 238s). Or retry incomplete responses one clip per request; no prompt or model change is needed. |
| `source_eof_duration_mismatch`: the clip ends exactly at the stated source duration, and the streams end slightly earlier | 4 | `seed()` treats the caption-derived `source_duration_seconds` as a valid end. Cap the end at the probed stream duration minus ~1s, snapped to the last complete sentence. |
| Stored source has no audio stream (`eV396ioBs3g`) | 1 | `ffprobe` for an audio stream at ingest; one pass over the bucket to find others |
| Non-English source (Polish `5CUJExj5yVE`; Estonian `kwxB-hUVJcY`; an Estonian clip `SxmcmoslLmA` went live on Oct 1) | 2 | Language check at relevance and selection time. The English Whisper path returns no word timings for them. |
| Transient range-transfer error | 1 | A bounded retry for transfer errors that never reached a paid call |

Fixed subsets deliberately **never retry terminal failures**. That rule turned purely operational faults into permanent ones. **Add an authorized retry path for operational failure classes** (pre-Luna failures, incomplete responses, transfer errors) with archived originals, so they don't need an out-of-band retry.

## 6. Why 44% were held, and how to cut it

Escalation codes on the first 99 held clips (most clips carry several):

| Code | Clips | What it usually is |
|---|---|---|
| `caveat_uncertain` | 82 | The verifier's general below-0.95 flag |
| `critical_transcript_disagreement` | 46 | Whisper vs captions on one word: negations (“can/can’t”, “don’t/will”), numbers (0.1% vs 1%), proper nouns (“Anthropic”/“Infropic”, “OpenAI”/“Urban Air”) |
| `boundary_uncertain` | 36 | First or last word clipped (“[I] can’t see how…”, “…to be [immortal]”) |
| `context_missing` | 15 (24 of the final 129) | The AI subject is spoken just before the cut (“them”, “these systems”) |
| `attribution_uncertain` | 8 | An interviewer turn in the clip, or the wrong person labelled (a panel label instead of Hinton) |

**Highest-leverage changes, in order:**

1. **Snap recipe boundaries to sentence edges with ~0.3s padding** before rendering. That removes most `boundary_uncertain` holds and the end-of-file failures.
2. **Settle word disputes with a second transcription of the source span before escalating.** Whisper `large-v3` + `medium`, or OpenAI `gpt-4o-transcribe` / `gpt-audio-1.5`, which was used for root checks. The Mac retry found most disputes resolve this way. Note that Luna's escalation timestamps were often 8–30s off: locate the phrase in the clip's own ASR first.
3. **Auto-include a compact lead-in (≤30s, total ≤240s) when the AI subject sits just before the cut.**
4. **Auto-add “+ interviewer” to the speaker label** when the ASR shows a second voice.

Together these should move a large share of the 44% into automatic publication without lowering the 0.95 release gate.

## 7. State of the code

The runtime that produced this run is the `snippy-291-identity-recovery` branch: about 48 commits on top of an older `main`, including `ccf00fd`, `2eba007` and `2394a13`. **It is not yet on GitHub.** It was shipped to Shadow as git bundles over Relay, so the only copies are local worktrees and Shadow. Landing it on `main` (rebasing past `main`'s own `scripts/relevance` changes) is the next code task.
