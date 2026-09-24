#!/usr/bin/env python3
"""
How well the sections match what people hear: SongFormer, the fusion the show
uses, and the self-similarity labeller, scored against human annotations of
real music.

    python scripts/eval-structure.py                 10 tracks
    python scripts/eval-structure.py --tracks 30 --seed 3

The music is SALAMI's Internet Archive subset (Smith et al., 2011): live
recordings that are free to download, each annotated by one or two people with
where the sections change and what each one is. The audio and the annotations
are fetched at run time into ~/.cache/artnet-lightshow/eval and never
redistributed. Synthetic tracks can prove the plumbing; only this can say
whether the answers are right.

For each system it reports, averaged over every track and annotator:

    HR3F, HR.5F   boundary hit rate F-measure within 3 s and 0.5 s
    labels        the share of the track whose section name matches the
                  annotation, compared every half second in one vocabulary
                  (intro, verse, pre-chorus, chorus, bridge, instrumental,
                  outro); SALAMI's other labels (silence, applause, …) are
                  not scored

and the share an answer of "verse" everywhere would get, for scale. SongFormer
runs as the analyser would run it, so on a CPU it takes most of each track's
length; its answers are cached and a second run re-scores in minutes.

Caveats worth keeping in mind: these are live bands, not studio pop or club
tracks, and whether SongFormer's training data included SALAMI is not known.
"""

import argparse
import csv
import io
import json
import math
import os
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from analysis import (bands, dynamics, features, preprocess, rhythm,  # noqa: E402
                      songformer, structure)

SALAMI = 'https://raw.githubusercontent.com/DDMAL/salami-data-public/master'
CACHE = Path(os.environ.get('ARTNET_EVAL_DIR', Path.home() / '.cache' / 'artnet-lightshow' / 'eval' / 'salami'))

# SALAMI's function labels, and SongFormer's, in one vocabulary.
CANON = {
    'intro': 'intro', 'pre-intro': 'intro',
    'verse': 'verse', 'pre-verse': 'verse',
    'pre-chorus': 'prechorus', 'prechorus': 'prechorus',
    'chorus': 'chorus', 'post-chorus': 'chorus',
    'bridge': 'bridge',
    'instrumental': 'inst', 'inst': 'inst', 'solo': 'inst', 'interlude': 'inst', 'break': 'inst',
    'theme': 'inst', 'main_theme': 'inst', 'secondary_theme': 'inst', 'head': 'inst',
    'outro': 'outro', 'coda': 'outro', 'fade-out': 'outro',
}
# The show's roles in the same vocabulary. A drop is the loud section, which
# in SALAMI's terms is the chorus; a breakdown is a quiet instrumental.
ROLES = {'intro': 'intro', 'verse': 'verse', 'prechorus': 'prechorus', 'chorus': 'chorus',
         'drop': 'chorus', 'bridge': 'bridge', 'instrumental': 'inst', 'breakdown': 'inst',
         'outro': 'outro'}


def fetch(url):
    request = urllib.request.Request(url.replace('http://', 'https://'),
                                     headers={'User-Agent': 'artnet-lightshow eval-structure'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def fetch_audio(url, path):
    """The track. The index's `_vbr.mp3` files have since been renamed; the
    item's file list finds the same track under its current name."""
    try:
        path.write_bytes(fetch(url))
        return
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
    item, name = url.split('/download/')[1].split('/')[0], url.rsplit('/', 1)[1]
    stem = name.rsplit('.', 1)[0].replace('_vbr', '')
    files = json.loads(fetch(f'https://archive.org/metadata/{item}'))['files']
    for ext in ('.mp3', '.ogg', '.flac'):
        for f in files:
            if f['name'].endswith(stem + ext):
                path.write_bytes(fetch(f'https://archive.org/download/{item}/{f["name"]}'))
                return
    raise FileNotFoundError(f'{stem} is not in {item} any more')


def annotation(song_id, which):
    path = CACHE / 'annotations' / f'{song_id}-{which}.txt'
    if not path.exists():
        try:
            text = fetch(f'{SALAMI}/annotations/{song_id}/parsed/textfile{which}_functions.txt').decode()
        except urllib.error.HTTPError:
            text = ''
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    rows = []
    for line in path.read_text().strip().splitlines():
        parts = line.split('\t')
        if len(parts) == 2:
            rows.append((float(parts[0]), parts[1].strip().lower()))
    return rows or None


def choose(count, seed):
    index = CACHE / 'id_index_internetarchive.csv'
    if not index.exists():
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_bytes(fetch(f'{SALAMI}/metadata/id_index_internetarchive.csv'))
    tracks = list(csv.DictReader(io.StringIO(index.read_text())))
    random.Random(seed).shuffle(tracks)
    chosen = []
    for row in tracks:
        # A song form to score against: verses and choruses, two to five and
        # a half minutes.
        if not 150 <= float(row['SONG_DURATION'] or 0) <= 330:
            continue
        first = annotation(row['SONG_ID'], 1)
        labels = {label for _, label in first or ()}
        if 'verse' in labels and 'chorus' in labels:
            chosen.append(row)
        if len(chosen) >= count:
            break
    return chosen


def boundaries(rows, duration):
    return np.array(sorted({round(t, 3) for t, label in rows if 0.5 < t < duration - 0.5 and label != 'end'}))


def hit_rate(ref, est, window):
    """F-measure of boundaries matched one-to-one within `window` seconds."""
    from scipy.optimize import linear_sum_assignment
    if not len(ref) or not len(est):
        return 0.0
    distance = np.abs(ref[:, None] - est[None, :])
    cost = np.where(distance <= window, distance, 1e6)
    r, c = linear_sum_assignment(cost)
    hits = int(np.sum(cost[r, c] < 1e6))
    precision, recall = hits / len(est), hits / len(ref)
    return 2 * precision * recall / (precision + recall) if hits else 0.0


def label_at(rows, t):
    current = None
    for start, label in rows:
        if start > t:
            break
        current = label
    return CANON.get(current) if current else None


def label_score(ref_rows, sections, vocabulary, duration):
    agree = total = 0
    for t in np.arange(0, duration, 0.5):
        wanted = label_at(ref_rows, t)
        if not wanted:
            continue
        got = next((s['label'] for s in sections if s['start'] <= t < s['end']), None)
        total += 1
        agree += int(vocabulary.get(got) == wanted)
    return agree / total if total else math.nan


def analyse(path, cached_rows):
    audio = preprocess.prepare(str(path))
    frames = features.extract(audio)
    grid = rhythm.analyse(audio, frames)
    band_map = bands.analyse(frames, grid.beats)
    roles = bands.infer_roles(frames, band_map)
    drops = [d.to_dict() for d in dynamics.analyse(frames, band_map, grid).drops]
    labeller = structure.analyse(frames, grid, roles, drops)
    rows = cached_rows
    if rows is None:
        rows = songformer.sections(np.mean(audio.source, axis=0), audio.source_rate)
    fused = structure.analyse(frames, grid, roles, drops, model_sections=rows)
    as_rows = lambda secs: [{'start': s.start, 'end': s.end, 'label': s.role} for s in secs]  # noqa: E731
    return audio.duration, as_rows(labeller), rows, as_rows(fused)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--tracks', type=int, default=10)
    parser.add_argument('--seed', type=int, default=7)
    args = parser.parse_args(argv)
    if not songformer.available():
        print(f'SongFormer is not installed: {", ".join(songformer.missing())}', file=sys.stderr)
        return 1

    scores = {name: {'hr3': [], 'hr05': [], 'labels': []} for name in ('labeller', 'songformer', 'fused')}
    verse = []
    for row in choose(args.tracks, args.seed):
        song = row['SONG_ID']
        audio = CACHE / 'audio' / f'{song}.audio'
        cached = CACHE / 'songformer' / f'{song}.json'
        audio.parent.mkdir(parents=True, exist_ok=True)
        cached.parent.mkdir(parents=True, exist_ok=True)
        try:
            if not audio.exists():
                fetch_audio(row['URL'], audio)
        except Exception as exc:
            print(f'{song}: no audio ({exc})', file=sys.stderr)
            continue
        duration, labeller, rows, fused = analyse(audio, json.loads(cached.read_text()) if cached.exists() else None)
        cached.write_text(json.dumps(rows))
        if abs(duration - float(row['SONG_DURATION'])) > 3:
            print(f'{song}: {duration:.0f} s here, {row["SONG_DURATION"]} s annotated; skipped', file=sys.stderr)
            continue
        systems = {'labeller': (labeller, ROLES), 'songformer': (rows, CANON), 'fused': (fused, ROLES)}
        for which in (1, 2):
            ref_rows = annotation(song, which)
            if not ref_rows:
                continue
            ref = boundaries(ref_rows, duration)
            verse.append(label_score(ref_rows, [{'start': 0, 'end': duration, 'label': 'verse'}], CANON, duration))
            for name, (sections, vocabulary) in systems.items():
                est = np.array(sorted(s['start'] for s in sections[1:]))
                scores[name]['hr3'].append(hit_rate(ref, est, 3.0))
                scores[name]['hr05'].append(hit_rate(ref, est, 0.5))
                scores[name]['labels'].append(label_score(ref_rows, sections, vocabulary, duration))
        print(f'{song} {row["ARTIST"]} — {row["TITLE"]}: done', file=sys.stderr, flush=True)

    if not verse:
        print('nothing was scored', file=sys.stderr)
        return 1
    print(f'{"":12} {"HR3F":>6} {"HR.5F":>6} {"labels":>7}    over {len(verse)} track-annotator pairs')
    for name, m in scores.items():
        print(f'{name:12} {np.mean(m["hr3"]):6.3f} {np.mean(m["hr05"]):6.3f} {np.nanmean(m["labels"]):7.3f}')
    print(f'{"all verse":12} {"":>6} {"":>6} {np.nanmean(verse):7.3f}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
