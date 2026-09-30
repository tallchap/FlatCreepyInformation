# Shadow production operation

Base: `d27ca786acb72458e97167ee39d95d2dd22ef8a7`. The existing Luna prompts,
decision schema, independent verifier, five-round ceiling and 0.95 release gate
remain the editorial contract. These adapters add Windows execution, bounded
concurrency, resume identities and operational evidence only.

For Relay job `SNIPPY-LUNA-CODEX-1644-20260930`, the posting session's
2026-09-30 20:56:24Z update authorizes two sequential experiments, each with ten
groups of five fresh candidates. Report and preserve round one before launching
round two; stop after round two for cost and time review. The total admission cap
is 100 fresh candidates. Each round selects seven eligible groups and three
review groups, for 35 eligible and 15 review candidates. Failed preparation does
not authorize a replacement candidate outside its frozen set, and round two must
not retry any round-one candidate.
Every Astra referral stays pending and unpublished; do not invoke an editorial
Astra or Claude fallback.

## Inputs and prior state

Use Relay `fetch --kind input` and verify its committed receipt first. Run
`bootstrap_shadow.py --inputs INPUTS --root RUN` once. It preserves the original
Mac checkpoint, imports its 19 publications as prior receipts, and reserves
`-MkGsHg_EHE` for the Mac. `verify_checkpoint.py` checks all 19 against GCS,
BigQuery and the live site. Its successful result belongs at
`RUN/prior-verification.json`. Historical Mac paths are evidence locations;
only transferred artifacts have Windows mappings.

The private environment file lives outside the repository and checkpoint root.
Only an existing OpenAI key and Google service-account path are needed. Never
copy that file, a Relay wallet, or credentials into an artifact bundle.

## CUDA ASR

Run `whisper_cuda.py` with the existing local-whisper Python environment.
Set `SNIPPY_WHISPER_PYTHON` to that interpreter before running production.
The adapter requires the cached `small.en` model and an actual CUDA device.
The original `--fp16 False` flag maps to CUDA float32. It records actual model,
device, compute type, media SHA and word timings. No model, CPU or paid-STT
fallback is permitted. A real audio roundtrip gate is retained separately.

## Admission and recovery

Use `supervise_shadow.py --help` for the exact explicit arguments. Its private
session file must be the claiming root worker's wallet. The supervisor and its
exact subprocesses share that wallet; unrelated agents never do.

The bounded experiment freezes its candidate list before work, prepares media
under the shared render limit and single GPU ASR lock, and releases the ten
independent Luna groups after preparation. Publication is serialized. Each paid
batch has immutable membership and evidence hashes, so a partial publication
cannot shrink its request and accidentally call Luna again.

An unanswered API intent is retained as an unknown-charge record and is not
retried. Only an explicit HTTP 429 receives bounded retries honoring Retry-After.
Supervisor recovery is limited and durable across restarts. The experiment's
frozen admission set survives recovery; a restart cannot select another 50.

## Evidence and delivery

`production_report.py --root RUN` writes a lightweight report and coverage CSV.
Its `--verify` mode hashes final evidence and exits nonzero for pending work,
operational failures, missing receipts or integrity errors. Awaiting Astra is
reported separately from publication completion.

`benchmark_report.py` reports this experiment's usage-derived costs, response IDs,
token categories, transport overlap, failures and measured stage durations.
Usage-derived cost is not a provider invoice; unknown-charge calls stay explicit.

`checkpoint_shadow.py --root RUN --output CHECKPOINTS` creates an immutable compact
snapshot with receipts, recipes, ASR, frames, source context and media locators.
It omits footage and private configuration. Attach its returned directory with
Relay `send JOB DIRECTORY --kind response --tag LABEL`; this records a verified
progress receipt while keeping the claim active. It is distinct from `respond`,
which freezes the worker's final response and ends the active claim.

Unpublished media remains on Shadow. `media-inventory.json` provides exact paths,
sizes and hashes for a later targeted Relay transfer. Original sources are never
deleted. Only the originating consumer validates and acknowledges a final response.
