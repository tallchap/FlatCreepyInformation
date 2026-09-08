#!/usr/bin/env python3
"""Enrich scraped video ids via the YouTube Data API v3 and append them as a
NEW tab in the Snippysaurus YT Home tracking sheet.

Usage:
  python3 enrich-append.py <scraped.json> [tab-suffix] [--dry-run]

  tab-suffix  appended to the auto tab name, e.g. "post-watch"
              -> "Run 7 — 2026-09-08 post-watch"
  --dry-run   fetch metadata and read the sheet, but write nothing; prints the
              tab name that WOULD be created plus the first rows.

Config — environment variables win; otherwise the first .env.local found in
SNIPPY_ENV_FILE, the repo root (../../.env.local), or the canonical
snippysaurus-live checkout is parsed:
  YOUTUBE_API_KEY                      YouTube Data API v3 key (~2 quota units / 100 videos)
  GOOGLE_APPLICATION_CREDENTIALS_JSON  service-account JSON with Editor on the sheet
  SNIPPY_SHEET_ID                      id of the tracking sheet ("Snippysaurus YT Home")

Columns written: rank, published, channel, title, description, duration,
views, url, channel_url. Publish times are exact ISO datetimes (not "3 months
ago"), views are numeric, durations are real Sheets durations shown [h]:mm:ss.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

HERE = Path(__file__).resolve().parent
ENV_CANDIDATES = [
    os.environ.get('SNIPPY_ENV_FILE'),
    HERE.parents[1] / '.env.local',                                   # repo root
    Path.home() / 'Desktop/ClaudeCode/snippysaurus-live/.env.local',  # canonical checkout
]


def load_env_file():
    """Parse the first existing .env.local into os.environ (without overriding)."""
    for cand in ENV_CANDIDATES:
        if not cand:
            continue
        p = Path(cand)
        if not p.is_file():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in '\'"':
                v = v[1:-1]
            os.environ.setdefault(k, v)
        return p
    return None


def require(name):
    v = os.environ.get(name)
    if not v:
        sys.exit(f'{name} not set and no .env.local found in: '
                 + ', '.join(str(c) for c in ENV_CANDIDATES if c))
    return v


def yt_fetch(ids, api_key):
    out = {}
    for i in range(0, len(ids), 50):
        chunk = ','.join(ids[i:i + 50])
        url = ('https://www.googleapis.com/youtube/v3/videos'
               f'?part=snippet,statistics,contentDetails&id={chunk}&key={api_key}')
        data = json.loads(urllib.request.urlopen(url).read())
        for it in data.get('items', []):
            out[it['id']] = it
    return out


def fmt_duration(iso, live):
    if live == 'live':
        return 'LIVE'
    m = re.match(r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso)
    d, hh, mm, ss = (int(x) if x else 0 for x in m.groups())
    return (d * 86400 + hh * 3600 + mm * 60 + ss) / 86400  # Sheets duration serial


def rows_for(videos, meta):
    rows = [['rank', 'published', 'channel', 'title', 'description', 'duration', 'views', 'url', 'channel_url']]
    missing = []
    for i, v in enumerate(videos):
        it = meta.get(v['id'])
        if not it:
            missing.append(v['id'])
            rows.append([i + 1, '', v.get('channel', ''), v.get('title', ''), '', '', '', v['url'], v.get('channelUrl', '')])
            continue
        sn, st, cd = it['snippet'], it.get('statistics', {}), it['contentDetails']
        desc = sn.get('description', '')
        rows.append([
            i + 1,
            sn['publishedAt'].replace('T', ' ').replace('Z', ''),
            sn['channelTitle'],
            sn['title'],
            # guard against Sheets parsing a leading = or + as a formula
            ("'" + desc) if desc.startswith(('=', '+')) else desc,
            fmt_duration(cd.get('duration', 'PT0S'), sn.get('liveBroadcastContent', 'none')),
            int(st['viewCount']) if 'viewCount' in st else '',
            f"https://www.youtube.com/watch?v={v['id']}",
            f"https://www.youtube.com/channel/{sn['channelId']}",
        ])
    return rows, missing


def main(argv):
    args = [a for a in argv if a != '--dry-run']
    dry_run = '--dry-run' in argv
    if len(args) < 1:
        sys.exit(__doc__)
    videos = json.load(open(args[0]))
    suffix = f' {args[1]}' if len(args) > 1 else ''

    env_path = load_env_file()
    api_key = require('YOUTUBE_API_KEY')
    raw_sa = require('GOOGLE_APPLICATION_CREDENTIALS_JSON')
    sheet_id = require('SNIPPY_SHEET_ID')
    creds = service_account.Credentials.from_service_account_info(
        json.loads(raw_sa), scopes=['https://www.googleapis.com/auth/spreadsheets'])
    sheets = build('sheets', 'v4', credentials=creds)

    n_tabs = len(sheets.spreadsheets().get(spreadsheetId=sheet_id).execute()['sheets'])
    tab = f'Run {n_tabs + 1} — {date.today().isoformat()}{suffix}'

    meta = yt_fetch([v['id'] for v in videos], api_key)
    rows, missing = rows_for(videos, meta)

    if dry_run:
        print(f'DRY RUN (env from {env_path or "environment"})')
        print(f'WOULD CREATE TAB: {tab}')
        print(f'ROWS: {len(rows) - 1}, API missing {len(missing)}: {missing}')
        for r in rows[:6]:
            print('  ', [str(c)[:40] for c in r])
        return

    add = sheets.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body={
        'requests': [{'addSheet': {'properties': {'title': tab}}}]}).execute()
    sid = add['replies'][0]['addSheet']['properties']['sheetId']
    sheets.spreadsheets().values().update(
        spreadsheetId=sheet_id, range=f"'{tab}'!A1",
        valueInputOption='USER_ENTERED', body={'values': rows}).execute()
    sheets.spreadsheets().batchUpdate(spreadsheetId=sheet_id, body={'requests': [
        {'repeatCell': {
            'range': {'sheetId': sid, 'startRowIndex': 1, 'endRowIndex': len(rows),
                      'startColumnIndex': 5, 'endColumnIndex': 6},
            'cell': {'userEnteredFormat': {'numberFormat': {'type': 'TIME', 'pattern': '[h]:mm:ss'}}},
            'fields': 'userEnteredFormat.numberFormat'}},
        {'repeatCell': {
            'range': {'sheetId': sid},
            'cell': {'userEnteredFormat': {'wrapStrategy': 'CLIP'}},
            'fields': 'userEnteredFormat.wrapStrategy'}},
        {'updateDimensionProperties': {
            'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 0, 'endIndex': len(rows)},
            'properties': {'pixelSize': 21},
            'fields': 'pixelSize'}},
    ]}).execute()

    print(f'TAB: {tab}')
    print(f'ROWS: {len(rows) - 1}, API missing {len(missing)}: {missing}')
    print(f'URL: https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={sid}')


if __name__ == '__main__':
    main(sys.argv[1:])
