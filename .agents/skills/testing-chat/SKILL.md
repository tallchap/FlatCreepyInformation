# Testing the Chat Feature (Snippysaurus)

## Overview
The chat feature at `/chat` lets users select a speaker and ask questions about their video transcript history. The LLM returns verbatim quotes with clickable citation links that open Snippysaurus video pages at the exact timestamp.

## Prerequisites

### Environment Variables
- `OPENAI_API_KEY` — needed for OpenAI Assistants API
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` — Google service account JSON for BigQuery transcript lookups

### Devin Secrets Needed
- `OPENAI_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`

## Local Setup
1. Create `.env.local` in the repo root with both env vars
2. Run `npm run dev` to start the Next.js dev server on port 3000
3. Navigate to `http://localhost:3000/chat`

## Testing Procedure

### Chat Flow
1. Select a speaker from the dropdown (e.g., "Eliezer Yudkowsky" or "Liron Shapira")
2. Type a question and press Enter
3. Wait for the streaming response to complete (may take 15-30 seconds due to OpenAI + BigQuery calls)
4. Verify citations appear as **blue clickable links with play icons** (not raw markdown)

### Citation Link Verification
1. Hover over a citation link — URL should show `/video/VIDEO_ID?t=INTEGER` (no decimal timestamps)
2. Click the link — should open the video page (not 404)
3. On the video page, verify the YouTube embed has `?start=INTEGER&autoplay=1` in the iframe src
4. The video should auto-play starting near the quoted passage

### Multi-Query Testing
Always test with at least 2-3 different queries across different speakers to catch edge cases. Different queries may hit different video IDs and timestamp ranges.

## Common Issues

### Credentials from Slack are truncated
Slack truncates long strings (like private keys). If BigQuery returns `ERR_OSSL_UNSUPPORTED`, the private key is likely truncated. Request fresh credentials via the secure channel (`request_secret` tool) instead of copying from Slack messages.

### Decimal timestamps in citations
BigQuery returns timestamps as floats (e.g., `3807.78`). The code floors these to integers at three levels:
1. **Server-side** (`src/app/api/chat/route.ts`): `Math.floor()` before sending to client
2. **Client-side** (`src/components/chat/chat-window.tsx`): `Math.floor()` when encoding youtube reference
3. **Regex** (`src/components/chat/message-bubble.tsx`): Accepts decimals and floors when generating href

If citations appear as raw markdown text instead of clickable links, check that all three layers are applying `Math.floor()`.

### ESLint circular JSON error
The repo may have a pre-existing ESLint config issue that causes `npm run lint` to fail with a circular JSON error. This is unrelated to chat feature changes.

### Vercel Preview Testing
Vercel preview deployments require `OPENAI_API_KEY` and `GOOGLE_APPLICATION_CREDENTIALS_JSON` to be set in Vercel project environment variables. Without them, the chat API will return errors on the preview URL.

## Architecture Notes
- OpenAI Assistants API with File Search (gpt-4.1 model)
- Individual transcript files per video uploaded to vector stores
- Server-side citation mapping: OpenAI file citation annotations → real video IDs via `file-citation-map.json`
- Timestamp matching: sliding window algorithm across 5 transcript segments with 30% word overlap threshold
- SSE streaming: thread_id → text_delta events → citations event (with resolved video IDs + timestamps) → done
