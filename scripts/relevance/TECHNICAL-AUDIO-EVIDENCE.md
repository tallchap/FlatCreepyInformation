# Actual-audio evidence on the existing OpenAI account

Luna does not support audio input. This separate helper uses `gpt-audio-1.5` through Chat Completions for technical audio evidence only. The frozen Luna finalizer/verifier and root editorial ownership remain unchanged. Credentials come from the existing `audit.api_key()` path; no alternate key is selected.

```sh
python3 scripts/relevance/technical_audio_evidence.py --media /path/clip.mp4 --out /path/new-immutable-attempt
```

The helper extracts PCM audio directly from the exact MP4, binds media/audio/request hashes, reserves a fresh attempt directory, and saves a receipt before the request. A used directory always fails rather than replaying a request. Provider responses are saved before validation; network ambiguity, malformed/truncated output and media mutation never yield ready evidence. Inspect failures before any deliberate new attempt; there is no automatic retry.

Evidence readiness is not publication approval. Root compares the analysis against source context and independent ASR; models can confidently mishear words. This is neither human listening nor speaker identification. Do not use it to bypass uncertain boundaries, source generation checks, editorial approval or exclusive publication ownership. Limit technical audio calls to two concurrent requests. The production ASR/render concurrency remains unchanged.

Live probe 2026-10-02: existing account returned HTTP200 for a25.6second held clip. Receipt is in the Seville workspace `astra-review/yKp8dBponDQ-current/openai-audio-evidence.json`; token-rate estimate$0.010597, not invoice.

Official capability and pricing references:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-audio-1.5
- https://developers.openai.com/api/docs/guides/audio-chat-completions
