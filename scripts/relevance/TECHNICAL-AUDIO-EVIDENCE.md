# Actual-audio evidence on the existing OpenAI account

Luna does not support audio input. This separate helper uses `gpt-audio-1.5` through Chat Completions for technical audio evidence only. The frozen Luna finalizer/verifier and root editorial ownership remain unchanged. Credentials come from the existing `audit.api_key()` path; no alternate key is selected.

```sh
python3 scripts/relevance/technical_audio_evidence.py --media /path/clip.mp4 --out /path/new-immutable-attempt
```

Requires Python 3.11+ and FFmpeg/FFprobe on PATH. Inputs must have exactly one audio stream; explicitly mix separate speaker tracks before using the helper.

The helper extracts PCM audio directly from the exact MP4, binds media/audio/request hashes, reserves a fresh attempt directory, and saves a receipt before the request. A used directory always fails rather than replaying a request. Raw provider response bytes, HTTP status and request ID are saved before JSON decoding; network ambiguity, malformed/truncated output and media mutation never yield ready evidence. Inspect failures before any deliberate new attempt; there is no automatic retry.

Evidence readiness is not publication approval. Root compares the analysis against source context and independent ASR; models can confidently mishear words. This is neither human listening nor speaker identification. Do not use it to bypass uncertain boundaries, source generation checks, editorial approval or exclusive publication ownership. Limit technical audio calls to two concurrent requests. The production ASR/render concurrency remains unchanged.

Live validation on 2026-10-02: the existing account returned HTTP 200 for two held clips (25.6 and 90.72 seconds). The combined token-rate estimate was $0.0437585, not an invoice. Model output included a transcription disagreement, reinforcing the requirement for independent review.

Run offline regression checks with `python3 -m unittest discover -s scripts/relevance -p test_technical_audio_evidence.py -v`. Tests include real FFmpeg extraction and rejection of multiple audio streams when FFmpeg is installed; no paid requests are made.

Official capability and pricing references:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-audio-1.5
- https://developers.openai.com/api/docs/guides/audio-chat-completions
