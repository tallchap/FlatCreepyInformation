# Testing the Chat Feature (Speaker Transcript Search)

## Overview
The chat feature at `/chat` lets users select a speaker and ask questions about their transcript history. The assistant uses OpenAI's Assistants API with File Search to find relevant transcript passages and return verbatim quotes with citation links to Snippysaurus video pages.

## Devin Secrets Needed
- `OPENAI_API_KEY` — OpenAI API key for Assistants API access
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` — Google service account JSON for BigQuery access (used by video pages to load metadata)

## Local Dev Server Setup
1. Export both environment variables in the shell
2. Run `npm run dev` from the repo root
3. Navigate to `http://localhost:3000/chat`

## Key Test Flow: Citation Link Verification
This is the most critical test — the user has been burned by hallucinated video IDs in citations.

1. Navigate to `/chat`
2. Select a speaker from the dropdown (e.g., "Eliezer Yudkowsky")
3. Ask a question that requires transcript citations (e.g., "What has Eliezer said about transhumanism? Give me direct quotes with sources.")
4. Wait for the full response to stream in — citations appear as raw `【...†source】` markers during streaming, then get replaced with clickable blue links (with play icons) after streaming completes
5. **Click each citation link** and verify:
   - The video page loads (NOT a 404)
   - The URL is `/video/REAL_VIDEO_ID` where REAL_VIDEO_ID is 11 alphanumeric characters
   - The video page shows title, embedded YouTube player, and transcript

## Known Issues & Gotchas

### Citation Timing
Citations are resolved server-side AFTER the streaming run completes. There will be a brief moment where raw annotation markers (`【4:3†source】`) are visible in the text before they get replaced with clickable links. This is expected behavior.

### Video Titles with Special Characters
Some video titles contain square brackets (e.g., `[Percontations]`), parentheses, or other special characters. The regex in `message-bubble.tsx` uses `.+?` (lazy match) instead of `[^\]]+` to handle these. If new title formats cause rendering issues, check the regex at `src/components/chat/message-bubble.tsx` in the `formatContent` function.

### File Citation Map Staleness
The file `src/lib/file-citation-map.json` is a static mapping of OpenAI `file_id` → `video_id`. If the vector stores are ever recreated (e.g., by re-running `scripts/reupload-individual-transcripts.mjs`), this JSON file MUST be regenerated and committed, or citations will silently fail to resolve.

### Verifying Video IDs Against BigQuery
To check if a video ID is real (not hallucinated), you can query BigQuery:
```sql
SELECT ID, Video_Title FROM `youtubetranscripts-429803.transcripts.transcripts_main` WHERE ID = 'VIDEO_ID_HERE'
```
If the query returns no rows, the video ID is hallucinated.

## Architecture Notes
- **Backend**: `src/app/api/chat/route.ts` — streams assistant response, then fetches annotations to resolve file_id → video_id mapping
- **Frontend**: `src/components/chat/chat-window.tsx` — handles SSE events including `citations` event that replaces markers with links
- **Rendering**: `src/components/chat/message-bubble.tsx` — `formatContent()` converts `[Title](youtube:VIDEO_ID)` markdown into clickable HTML links
- **Assistants**: Defined in `src/lib/assistants.ts` — currently Yudkowsky and Shapira
- **Mapping**: `src/lib/file-citation-map.json` — maps OpenAI file IDs to real video metadata
