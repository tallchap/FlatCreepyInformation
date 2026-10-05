"""Pure decision logic for the corpus integrity tool. No I/O: every function here is unit tested."""
import re
import unicodedata

# Same-recording thresholds for re-upload detection (sampled 7-word shingles).
# Both directions must clear MIN_CONTAIN, so a short clip cut from a long
# episode (high containment one way only) is never treated as a duplicate.
MIN_CONTAIN = 0.5
MAX_LENGTH_RATIO = 1.15
# A transcript that ends before this share of the real video is incomplete.
MIN_COVERAGE = 0.8
# A re-fetched transcript replaces the stored one only if it covers this much more.
MIN_COVERAGE_GAIN = 0.1

# Tables whose rows are someone's work; a re-upload that owns any is never deleted.
USER_CONTENT_TABLES = ('clips', 'clip_exports', 'opus_clips', 'snippets_vizard')


def strip(s):
    """Match the app's stripDiacritics (NFD, drop combining marks)."""
    return ''.join(ch for ch in unicodedata.normalize('NFD', s or '') if unicodedata.category(ch) != 'Mn')


def speakers(speaker_source):
    """speaker_source → ordered, de-duplicated names (the app splits on commas)."""
    out = []
    for name in (speaker_source or '').split(','):
        name = name.strip()
        if name and strip(name).lower() not in {strip(n).lower() for n in out}:
            out.append(name)
    return out


def parse_length(value):
    """Stored video_length (H:MM:SS, M:SS or plain seconds) → seconds, None if unparseable."""
    if value is None:
        return None
    if not re.fullmatch(r'\d+(:\d+){0,2}', str(value).strip()):
        return None
    parts = [int(p) for p in str(value).strip().split(':')]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0]


def format_length(seconds):
    """Seconds → the app's formatDuration output: H:MM:SS with hours, else M:SS."""
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'


def length_wrong(stored, true_seconds):
    parsed = parse_length(stored)
    if not true_seconds:
        return False
    return parsed is None or abs(parsed - true_seconds) > max(5, 0.03 * true_seconds)


def speaker_plan(speaker_source, files):
    """Chat files for one video vs its speaker_source.

    files: [{'file_id', 'speaker'}]. Returns (stale_file_ids, missing_speakers, extra_copy_ids):
    files for speakers no longer listed, listed speakers with no file, and surplus
    copies when one speaker has several files (the newest-listed one is kept).
    """
    wanted = {strip(s).lower(): s for s in speakers(speaker_source)}
    seen, stale, extra = {}, [], []
    for f in files:
        key = strip(f['speaker']).lower()
        if key not in wanted:
            stale.append(f['file_id'])
        elif key in seen:
            extra.append(f['file_id'])
        else:
            seen[key] = f['file_id']
    missing = [name for key, name in wanted.items() if key not in seen]
    return stale, missing, extra


def is_same_recording(pair, true_a, true_b):
    """pair: {'shared','na','nb'} from the shingle join; true_*: real durations (may be None)."""
    if min(pair['na'], pair['nb']) == 0:
        return False
    both = min(pair['shared'] / pair['na'], pair['shared'] / pair['nb'])
    if both < MIN_CONTAIN:
        return False
    if true_a and true_b and max(true_a, true_b) / min(true_a, true_b) > MAX_LENGTH_RATIO:
        return False
    return True


def group_duplicates(pairs):
    """Union-find over confirmed same-recording pairs → sorted list of sorted groups."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups = {}
    for x in parent:
        groups.setdefault(find(x), []).append(x)
    return sorted(sorted(g) for g in groups.values() if len(g) > 1)


def choose_survivor(group, info):
    """Pick which upload of one recording to keep.

    info[video_id]: {'user_content': int, 'bunny': bool, 'on_youtube': bool,
                     'published': 'YYYY-MM-DD' or None, 'segments': int}
    Order: owns user content > has a Bunny copy > still on YouTube > published
    first (the original, re-uploads come later) > longer transcript > id.
    Returns (survivor, losers, reason) or (None, [], reason) when two copies both
    own user content and neither can be deleted safely.
    """
    owners = [v for v in group if info[v]['user_content']]
    if len(owners) > 1:
        return None, [], 'several uploads own clips/exports; left for a human'

    def key(v):
        i = info[v]
        return (
            -int(bool(i['user_content'])),
            -int(bool(i['bunny'])),
            -int(bool(i['on_youtube'])),
            i['published'] or '9999-99-99',
            -(i['segments'] or 0),
            v,
        )

    ordered = sorted(group, key=key)
    survivor = ordered[0]
    first, second = key(survivor), key(ordered[1])
    reasons = ('owns clips/exports', 'has the Bunny copy', 'still on YouTube', 'published first',
               'longer transcript', 'tie: lowest id')
    why = next(r for r, a, b in zip(reasons, first, second) if a != b)
    return survivor, ordered[1:], why


def person_key(name):
    """First + last name, accent/case-insensitive: 'Yuval Harari' == 'Yuval Noah Harari'."""
    parts = re.findall(r"[a-z0-9']+", strip(name).lower())
    return (parts[0], parts[-1]) if parts else ('', '')


def merged_speakers(group, survivor, speaker_sources):
    """Survivor's speakers first, then people only a deleted copy listed.
    A name variant of someone already listed is the same person, not a new speaker."""
    names = speakers(speaker_sources.get(survivor))
    seen = {person_key(n) for n in names}
    for v in group:
        if v == survivor:
            continue
        for n in speakers(speaker_sources.get(v)):
            if person_key(n) not in seen:
                names.append(n)
                seen.add(person_key(n))
    return ', '.join(names)


def coverage(last_time, true_seconds):
    if not true_seconds:
        return None
    return (last_time or 0) / true_seconds


def should_replace_transcript(old_cov, new_cov):
    return new_cov is not None and (old_cov is None or new_cov >= old_cov + MIN_COVERAGE_GAIN)


def select_bunny_deletions(wanted, items, transcribed):
    """Approved Bunny titles → (items to delete, titles not in Bunny, titles blocking the run).

    Blocking: a listed title that is itself a transcribed video, or any transcribed
    YouTube ID inside a listed item's title ("Test Video <id>" still serves that video).
    Any blocker means delete nothing.
    """
    chosen, missing = [], []
    for key in wanted:
        hits = [i for i in items if (i['title'] or '').strip() == key]
        (chosen.extend(hits) if hits else missing.append(key))
    blocking = sorted({t for i in chosen for t in re.findall(r'[\w-]{11}', i['title'] or '') if t in transcribed}
                      | {k for k in wanted if k in transcribed})
    return chosen, missing, blocking


def purge_targets(wanted, transcribed, owned):
    """Approved video IDs whose leftover rows may be deleted → (ids, blocking).
    Blocking: an ID that still has a transcript, or owns clips/exports. Any blocker
    means delete nothing."""
    ids = sorted({w for w in wanted if re.fullmatch(r'[\w-]{11}', w)})
    blocking = sorted(i for i in ids if i in transcribed or owned.get(i))
    return ids, blocking
