#!/usr/bin/env python3
"""
How well the analyser finds drops and build-ups, scored against people who
marked them, and how often it finds a drop in music that has none.

    python scripts/eval-dynamics.py                          50 + 50 tracks, the tuning split
    python scripts/eval-dynamics.py --save before.json       keep this run's numbers
    python scripts/eval-dynamics.py --compare before.json    after a change: the same tracks, each number beside what it was
    python scripts/eval-dynamics.py --split test             the held-out tracks, once the tuning is done
    python scripts/eval-dynamics.py --datasets raveform --tracks 10

Run it with the analysis environment's Python (project_venv or .venv): it
runs the analyser's own stages, Beat This! included.

Two sets of music, for two different questions:

    raveform  EDM tracks from DJ mixes, each marked by three people with its
              intro, buildup, breakdown, drop, cooldown and outro (Raveform,
              TISMIR; CC BY 4.0). Does a drop the analyser
              reports land on a drop, does it find them all, and does the
              build-up it hands the show start where the build-up does?
    harmonix  pop, hip-hop, rock, R&B, country, reggaeton, with the
              Dance/Electronic tracks left out (the Harmonix Set, Nieto et
              al., ISMIR 2019; MIT). None of it has a drop. Every drop the
              analyser reports here is one the show will light as a drop.

The annotations are fetched once: Raveform's `segments.json` out of its
480 MB archive by HTTP range requests (about 9 MB of traffic), Harmonix's
files from GitHub. The audio comes from YouTube through yt-dlp, as the show's
own search does, into ~/.cache/artnet-lightshow/eval, and is never
redistributed. A video that has gone, or is another version of the track
than the one annotated (its length differs), is noted and skipped on every
later run, and the next track in the draw takes its place.

Everything up to the dynamics stage (preprocessing, features, the beat
model, the bands) is cached per track, keyed on the source of the stages that
make it. So a change to dynamics.py or to DynamicsConfig re-scores all hundred
tracks in about a minute; a change upstream of it recomputes. The first run
downloads about a gigabyte and takes most of an hour (on an RTX 2070 Super).

What it reports:

    raveform  drop F-measure, precision and recall, matched one to one
              within a beat and within a bar of a marked drop (the start of
              a drop section that does not follow another); the same for
              the drops the analyser calls `proper` (the ones the show
              spends its blinder on); and, for every marked build-up that
              runs into a drop, whether the analyser found one ending on
              that drop, how far its start is from the marked start in
              bars, and how its length compares
    harmonix  drops a minute, all and `proper`; the share of tracks with at
              least one `proper` drop; the share of drops that sit on a
              chorus entry (within 2 s, where the video's length matches
              the annotation's), beside the share a drop placed at random
              would get; build-ups a minute

Caveats worth keeping in mind: Raveform is club music, mostly techno, trance,
drum & bass and house, sampled evenly across its genres; Harmonix's audio is
whatever YouTube has under the 2019 links; neither is French. Tune on
`--split tune` and read `--split test` once, at the end, or the numbers stop
meaning anything.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import pickle
import random
import re
import shutil
import subprocess
import sys
import time
import types
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))

from analysis import bands, dynamics, features, models, preprocess, rhythm  # noqa: E402
from analysis.config import DEFAULT  # noqa: E402

EVAL = Path(os.environ.get('ARTNET_EVAL_DIR', Path.home() / '.cache' / 'artnet-lightshow' / 'eval'))
RAVEFORM_ZIP = 'https://huggingface.co/datasets/taejunkim/raveform/resolve/main/raveform.zip'
RAVEFORM_SEGMENTS = 'raveform/structures/segments.json'
HARMONIX = 'https://raw.githubusercontent.com/urinieto/harmonixset/main/dataset'
USER_AGENT = 'artnet-lightshow eval-dynamics'

# Raveform's own eight folds: two held out, six to tune on. Harmonix has no
# folds, so a quarter of it by track number.
RAVEFORM_TEST_FOLDS = {0, 1}
# A video this far from the annotated length is another edit of the track.
LENGTH_TOLERANCE = {'raveform': 3.0, 'harmonix': 5.0}
# Harmonix's own check that the video is the song it annotated (DTW against
# the original audio); below this the link has drifted to something else.
HARMONIX_MIN_ALIGNMENT = 0.9
# The chorus-entry test needs the video and the annotation on one clock.
CHORUS_ENTRY_SEC = 2.0
CHORUS_ENTRY_LENGTH_SEC = 1.5
HARMONIX_CHORUS = {'chorus', 'altchorus', 'instchorus', 'chorusinst', 'quietchorus', 'intchorus'}

# The fields of the frame features the dynamics stage reads, and all the
# per-frame curves beside them, kept in the stage cache without the
# spectrograms (tens of megabytes a track). A change that makes dynamics read
# anything else fails with AttributeError on a cached track, and that track is
# recomputed in full, with a note to add the field here.
FRAME_FIELDS = ('times', 'sample_rate', 'hop_length', 'n_fft', 'rms', 'energy', 'loudness', 'centroid',
                'rolloff', 'rolloff_low', 'flux', 'zcr', 'flatness', 'percussive_onset')
BAND_FIELDS = ('name', 'low_hz', 'high_hz', 'envelope', 'raw', 'flux', 'onsets', 'energy', 'attack_ms',
               'decay_ms', 'variation', 'rhythmic', 'percussive_ratio', 'importance')
# Modules that do not feed the stages before dynamics; everything else in
# src/analysis is in the cache key, so a new module is included by default.
NOT_UPSTREAM = {'dynamics', 'events', 'structure', 'perception', 'pipeline', 'report', 'songformer', 'tagger',
                'stems', 'schema', 'live', 'realtime', 'cli', 'model_adapters', 'pulse', 'version'}


class Gone(Exception):
    """The track cannot be had: the video is gone, or is another version."""


def log(message):
    print(message, file=sys.stderr, flush=True)


def fetch(url, timeout=120):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def cached(path, url):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(fetch(url))
    return path


# ── Raveform ────────────────────────────────────────────────────────────────

class RangeFile(io.RawIOBase):
    """A remote file read by HTTP range requests, so zipfile can pick one
    member out of an archive without downloading the rest of it."""

    def __init__(self, url):
        request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            # The redirect's target: a signed URL on the CDN, valid for an hour.
            self.url = response.url
            self.size = int(response.headers['Content-Length'])
        self.pos = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[whence]
        self.pos = base + offset
        return self.pos

    def readinto(self, buffer):
        if self.pos >= self.size or not len(buffer):
            return 0
        end = min(self.size, self.pos + len(buffer)) - 1
        request = urllib.request.Request(self.url, headers={'User-Agent': USER_AGENT,
                                                            'Range': f'bytes={self.pos}-{end}'})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        buffer[:len(data)] = data
        self.pos += len(data)
        return len(data)


def raveform_tracks():
    path = EVAL / 'raveform' / 'segments.json'
    if not path.exists():
        log('raveform: fetching the annotations out of the archive')
        with zipfile.ZipFile(RangeFile(RAVEFORM_ZIP)) as archive:
            data = archive.read(RAVEFORM_SEGMENTS)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return json.loads(path.read_text())


def raveform_reference(track):
    """Marked drops (a drop section that does not follow another) and the
    build-ups that run into one, as (start, drop)."""
    sections = [s for s in track['sections'] if s['name'] != 'end']
    drops = [s['start'] for i, s in enumerate(sections)
             if s['name'] == 'drop' and (i == 0 or sections[i - 1]['name'] != 'drop')]
    builds = [(s['start'], after['start']) for s, after in zip(sections, sections[1:])
              if s['name'] == 'buildup' and after['name'] == 'drop']
    return drops, builds


def raveform_beats(track):
    """The annotated grid, from its tempo changes."""
    tempos = sorted(track.get('tempos') or [], key=lambda t: t['start'])
    out = []
    for i, tempo in enumerate(tempos):
        end = tempos[i + 1]['start'] if i + 1 < len(tempos) else track['duration']
        if tempo['bpm'] > 0:
            out.append(np.arange(tempo['start'], end, 60.0 / tempo['bpm']))
    return np.concatenate(out) if out else np.zeros(0)


def raveform_candidates(split, seed):
    """Tracks with a marked drop, drawn evenly across the genres: techno is
    two fifths of the set, and a draw in proportion would be mostly techno."""
    by_genre = defaultdict(list)
    for track in raveform_tracks():
        held_out = track['fold'] in RAVEFORM_TEST_FOLDS
        if (split == 'test' and not held_out) or (split == 'tune' and held_out):
            continue
        if raveform_reference(track)[0]:
            by_genre[track['genre']].append(track)
    rng = random.Random(seed)
    queues = []
    for genre in sorted(by_genre):
        rng.shuffle(by_genre[genre])
        queues.append(by_genre[genre])
    rng.shuffle(queues)
    while any(queues):
        for queue in queues:
            if queue:
                track = queue.pop()
                yield {
                    'dataset': 'raveform', 'id': track['id'], 'title': track['title'], 'genre': track['genre'],
                    'duration': float(track['duration']), 'url': f'https://www.youtube.com/watch?v={track["id"]}',
                    'track': track,
                }


# ── Harmonix ────────────────────────────────────────────────────────────────

def harmonix_candidates(split, seed):
    base = EVAL / 'harmonix'
    meta = csv.DictReader(io.StringIO(cached(base / 'metadata.csv', f'{HARMONIX}/metadata.csv').read_text()))
    urls = {r['File']: r['URL'] for r in csv.DictReader(
        io.StringIO(cached(base / 'youtube_urls.csv', f'{HARMONIX}/youtube_urls.csv').read_text()))}
    scores = {r['File']: float(r['score'] or 0) for r in csv.DictReader(io.StringIO(
        cached(base / 'youtube_alignment_scores.csv', f'{HARMONIX}/youtube_alignment_scores.csv').read_text()))}
    rows = []
    for row in meta:
        name = row['File']
        held_out = int(name[:4]) % 4 == 0
        if (split == 'test' and not held_out) or (split == 'tune' and held_out):
            continue
        if not row['Genre'] or row['Genre'] == 'Dance/Electronic':
            continue
        if name not in urls or scores.get(name, 0) < HARMONIX_MIN_ALIGNMENT:
            continue
        rows.append(row)
    random.Random(seed).shuffle(rows)
    for row in rows:
        yield {
            'dataset': 'harmonix', 'id': row['File'], 'title': f'{row["Artist"]} - {row["Title"]}',
            'genre': row['Genre'], 'duration': float(row['Duration']),
            'url': urls[row['File']].replace('http://', 'https://'),
        }


def harmonix_sections(name):
    text = cached(EVAL / 'harmonix' / 'segments' / f'{name}.txt', f'{HARMONIX}/segments/{name}.txt').read_text()
    rows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            rows.append((float(parts[0]), re.sub(r'\d+$', '', parts[1].lower())))
    return rows


def chorus_entries(rows):
    return [t for (t, label), (_, before) in zip(rows[1:], rows)
            if label in HARMONIX_CHORUS and before not in HARMONIX_CHORUS]


# ── Audio ───────────────────────────────────────────────────────────────────

def unavailable(dataset):
    path = EVAL / dataset / 'unavailable.json'
    return path, (json.loads(path.read_text()) if path.exists() else {})


def mark_unavailable(dataset, key, reason):
    path, known = unavailable(dataset)
    known[key] = reason
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(known, indent=1, sort_keys=True))


def ffmpeg():
    found = shutil.which('ffmpeg')
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


# What yt-dlp says about a video that is not coming back, as against a
# network error or a bot check that may pass on the next run.
GONE = re.compile(r'Video (is )?unavailable|Private video|has been removed|no longer available|account .* terminated'
                  r'|not available in your country|copyright', re.IGNORECASE)


def download(candidate):
    folder = EVAL / candidate['dataset'] / 'audio'
    target = folder / f'{candidate["id"]}.mp3'
    if target.exists():
        return target
    folder.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, '-m', 'yt_dlp', '--quiet', '--no-warnings', '--no-playlist',
               '-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '4',
               '-o', str(folder / f'{candidate["id"]}.%(ext)s')]
    # YouTube wants a JavaScript runtime since late 2025 (see src/ytdlp.ts).
    node = shutil.which('node')
    if node:
        command += ['--js-runtimes', f'node:{node}']
    tool = ffmpeg()
    if tool:
        command += ['--ffmpeg-location', tool]
    run = subprocess.run(command + [candidate['url']], capture_output=True, text=True, timeout=900)
    if run.returncode != 0 or not target.exists():
        for leftover in folder.glob(f'{candidate["id"]}.*'):
            leftover.unlink()
        message = (run.stderr or run.stdout).strip().splitlines()
        message = message[-1] if message else f'yt-dlp exit {run.returncode}'
        if GONE.search(run.stderr or ''):
            raise Gone(message)
        raise RuntimeError(message)
    return target


# ── Analysis ────────────────────────────────────────────────────────────────

def stage_key():
    """What the cached stages were made by: the analysis modules upstream of
    dynamics, config.py without DynamicsConfig, and the beat model's version."""
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'src' / 'analysis').glob('*.py')):
        if path.stem in NOT_UPSTREAM:
            continue
        text = path.read_text()
        if path.stem == 'config':
            text = re.sub(r'@dataclass\(frozen=True\)\nclass DynamicsConfig:.*?(?=\n@dataclass)', '', text, flags=re.S)
        digest.update(path.name.encode() + b'\0' + text.encode())
    try:
        from importlib.metadata import version
        digest.update(version('beat_this').encode())
    except Exception:
        pass
    return digest.hexdigest()[:12]


def slim(frames, band_map):
    kept = types.SimpleNamespace(**{name: getattr(frames, name) for name in FRAME_FIELDS})
    kept.n_frames = frames.n_frames
    kept.frame_rate = frames.frame_rate
    kept_bands = {name: types.SimpleNamespace(**{f: getattr(band, f) for f in BAND_FIELDS})
                  for name, band in band_map.items()}
    return kept, kept_bands


def upstream(path):
    """The stages before dynamics, exactly as the pipeline runs them."""
    audio = preprocess.prepare(str(path), DEFAULT.preprocess)
    frames = features.extract(audio, DEFAULT.preprocess)
    grid = rhythm.analyse(audio, frames, DEFAULT.rhythm)
    band_map = bands.analyse(frames, grid.beats)
    try:
        models.release_memory()
    except Exception:
        pass
    return audio.duration, frames, band_map, grid


def analyse(candidate, path, key, fresh):
    """(duration, the dynamics stage's answer, the beats, seconds spent, from cache)."""
    folder = EVAL / candidate['dataset'] / 'stages'
    store = folder / f'{candidate["id"]}.{key}.pkl'
    started = time.perf_counter()
    if store.exists() and not fresh:
        duration, frames, band_map, grid = pickle.loads(store.read_bytes())
        try:
            return (duration, dynamics.analyse(frames, band_map, grid, DEFAULT.dynamics), grid.beats,
                    time.perf_counter() - started, True)
        except AttributeError as exc:
            log(f'  dynamics reads something the stage cache leaves out ({exc}); recomputing. '
                'Add the field to FRAME_FIELDS or BAND_FIELDS in this script to keep re-scoring fast.')
    duration, frames, band_map, grid = upstream(path)
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob(f'{candidate["id"]}.*.pkl'):
        old.unlink()
    store.write_bytes(pickle.dumps((duration, *slim(frames, band_map), grid), protocol=pickle.HIGHEST_PROTOCOL))
    return (duration, dynamics.analyse(frames, band_map, grid, DEFAULT.dynamics), grid.beats,
            time.perf_counter() - started, False)


# ── Scoring ─────────────────────────────────────────────────────────────────

def hits(ref, est, window):
    """Estimates matched one to one to references within `window` seconds."""
    ref, est = np.asarray(ref, dtype=float), np.asarray(est, dtype=float)
    if not len(ref) or not len(est):
        return 0
    from scipy.optimize import linear_sum_assignment
    distance = np.abs(ref[:, None] - est[None, :])
    cost = np.where(distance <= window, distance, 1e6)
    r, c = linear_sum_assignment(cost)
    return int(np.sum(cost[r, c] < 1e6))


def beat_lag(detected, reference, period):
    """The median offset of the detected beats from the annotated ones, taken
    only over beats within a quarter beat of each other: how far the video is
    from the audio that was annotated, within a beat."""
    detected = np.asarray(detected, dtype=float)
    if not len(detected) or not len(reference):
        return None
    idx = np.clip(np.searchsorted(detected, reference), 1, len(detected) - 1)
    nearest = np.where(np.abs(detected[idx] - reference) < np.abs(detected[idx - 1] - reference),
                       detected[idx], detected[idx - 1])
    diff = nearest - reference
    close = diff[np.abs(diff) < period / 4]
    return float(np.median(close)) if len(close) >= 16 else None


def score_raveform(candidate, result):
    duration, dyn = result
    track = candidate['track']
    ref_drops, ref_builds = raveform_reference(track)
    beat = 60.0 / track['average_bpm']
    bar = 4 * beat
    drops = [{'t': round(d.t, 3), 'kind': d.kind, 'confidence': round(d.confidence, 3)} for d in dyn.drops]
    times = [d['t'] for d in drops]
    proper = [d['t'] for d in drops if d['kind'] == 'proper']
    builds = [{'start': round(b.start, 3), 'end': round(b.end, 3)} for b in dyn.buildups]
    matched_builds = []
    for start, drop in ref_builds:
        near = [b for b in builds if abs(b['end'] - drop) <= bar]
        if not near:
            matched_builds.append(None)
            continue
        found = min(near, key=lambda b: abs(b['end'] - drop))
        matched_builds.append({
            'startErrorBars': round((found['start'] - start) / bar, 2),
            'lengthRatio': round((found['end'] - found['start']) / max(1e-6, drop - start), 3),
        })
    return {
        'duration': duration, 'beat': beat,
        'refDrops': ref_drops, 'refBuilds': [list(b) for b in ref_builds],
        'drops': drops, 'builds': builds, 'matchedBuilds': matched_builds,
        'hitsBeat': hits(ref_drops, times, beat), 'hitsBar': hits(ref_drops, times, bar),
        'properHitsBeat': hits(ref_drops, proper, beat), 'proper': len(proper),
    }


def score_harmonix(candidate, result):
    duration, dyn = result
    drops = [{'t': round(d.t, 3), 'kind': d.kind, 'confidence': round(d.confidence, 3)} for d in dyn.drops]
    out = {
        'duration': duration,
        'drops': drops,
        'builds': [{'start': round(b.start, 3), 'end': round(b.end, 3)} for b in dyn.buildups],
        'proper': sum(d['kind'] == 'proper' for d in drops),
    }
    # Only where the video and the annotation are one length, and so on one clock.
    if abs(duration - candidate['duration']) <= CHORUS_ENTRY_LENGTH_SEC:
        entries = chorus_entries(harmonix_sections(candidate['id']))
        out['onChorusEntry'] = sum(any(abs(d['t'] - e) <= CHORUS_ENTRY_SEC for e in entries) for d in drops)
        out['chorusEntries'] = len(entries)
        # How much of the track is that close to a chorus entry: where a drop
        # dropped at random would land on one.
        grid = np.arange(0.0, duration, 0.1)
        near = np.zeros(grid.size, dtype=bool)
        for entry in entries:
            near |= np.abs(grid - entry) <= CHORUS_ENTRY_SEC
        out['chorusEntryCover'] = float(near.mean()) if grid.size else 0.0
    return out


def f_measure(hit, n_est, n_ref):
    precision = hit / n_est if n_est else 0.0
    recall = hit / n_ref if n_ref else 0.0
    return (2 * precision * recall / (precision + recall) if hit else 0.0), precision, recall


def median(values):
    values = [v for v in values if v is not None]
    return float(np.median(values)) if values else None


def summarise_raveform(rows):
    n_ref = sum(len(r['refDrops']) for r in rows)
    n_est = sum(len(r['drops']) for r in rows)
    n_proper = sum(r['proper'] for r in rows)
    f_beat, p_beat, r_beat = f_measure(sum(r['hitsBeat'] for r in rows), n_est, n_ref)
    f_bar, _, _ = f_measure(sum(r['hitsBar'] for r in rows), n_est, n_ref)
    f_proper, p_proper, _ = f_measure(sum(r['properHitsBeat'] for r in rows), n_proper, n_ref)
    matched = [m for r in rows for m in r['matchedBuilds']]
    found = [m for m in matched if m]
    minutes = sum(r['duration'] for r in rows) / 60
    return {
        'tracks': len(rows),
        'dropF1Beat': f_beat, 'dropPrecisionBeat': p_beat, 'dropRecallBeat': r_beat, 'dropF1Bar': f_bar,
        'properF1Beat': f_proper, 'properPrecisionBeat': p_proper,
        'dropsPerMinute': n_est / minutes if minutes else 0.0,
        'markedDropsPerMinute': n_ref / minutes if minutes else 0.0,
        'buildsFound': len(found) / len(matched) if matched else None,
        'markedBuilds': len(matched),
        'buildLengthSec': median([b['end'] - b['start'] for r in rows for b in r['builds']]),
        'markedBuildLengthSec': median([drop - start for r in rows for start, drop in r['refBuilds']]),
        'buildStartErrorBars': median([abs(m['startErrorBars']) for m in found]),
        'buildStartWithin2Bars': (sum(abs(m['startErrorBars']) <= 2 for m in found) / len(matched)) if matched else None,
        'buildLengthRatio': median([m['lengthRatio'] for m in found]),
    }


def summarise_harmonix(rows):
    minutes = sum(r['duration'] for r in rows) / 60
    timed = [r for r in rows if 'onChorusEntry' in r]
    timed_drops = sum(len(r['drops']) for r in timed)
    return {
        'tracks': len(rows),
        'dropsPerMinute': sum(len(r['drops']) for r in rows) / minutes if minutes else 0.0,
        'properPerMinute': sum(r['proper'] for r in rows) / minutes if minutes else 0.0,
        'tracksWithProper': sum(r['proper'] > 0 for r in rows) / len(rows) if rows else 0.0,
        'dropsOnChorusEntry': sum(r['onChorusEntry'] for r in timed) / timed_drops if timed_drops else None,
        'chorusEntryByChance': float(np.mean([r['chorusEntryCover'] for r in timed])) if timed else None,
        'chorusEntryTracks': len(timed),
        'buildsPerMinute': sum(len(r['builds']) for r in rows) / minutes if minutes else 0.0,
    }


# (key, label, format, which way is better: +1 up, -1 down, 0 neither)
REPORT = {
    'raveform': [
        ('tracks', 'tracks', '{:.0f}', 0),
        ('dropF1Beat', 'drop F, within a beat', '{:.3f}', 1),
        ('dropPrecisionBeat', '  precision', '{:.3f}', 1),
        ('dropRecallBeat', '  recall', '{:.3f}', 1),
        ('dropF1Bar', 'drop F, within a bar', '{:.3f}', 1),
        ('properF1Beat', '"proper" drop F, within a beat', '{:.3f}', 1),
        ('properPrecisionBeat', '  precision', '{:.3f}', 1),
        ('dropsPerMinute', 'drops a minute', '{:.2f}', 0),
        ('markedDropsPerMinute', '  marked', '{:.2f}', 0),
        ('buildsFound', 'marked build-ups found, ending on their drop', '{:.0%}', 1),
        ('buildLengthSec', 'build-up length, median s', '{:.1f}', 0),
        ('markedBuildLengthSec', '  marked', '{:.1f}', 0),
        ('buildStartErrorBars', 'build-up start error, median bars', '{:.1f}', -1),
        ('buildStartWithin2Bars', 'build-ups starting within 2 bars', '{:.0%}', 1),
        ('buildLengthRatio', 'build-up length / marked, median', '{:.2f}', 0),
    ],
    'harmonix': [
        ('tracks', 'tracks', '{:.0f}', 0),
        ('dropsPerMinute', 'drops a minute (there are none)', '{:.2f}', -1),
        ('properPerMinute', '"proper" drops a minute', '{:.2f}', -1),
        ('tracksWithProper', 'tracks with a "proper" drop', '{:.0%}', -1),
        ('dropsOnChorusEntry', 'drops on a chorus entry', '{:.0%}', -1),
        ('chorusEntryByChance', '  by chance', '{:.0%}', 0),
        ('chorusEntryTracks', '  tracks timed for it', '{:.0f}', 0),
        ('buildsPerMinute', 'build-ups a minute', '{:.2f}', 0),
    ],
}

DATASETS = {
    'raveform': (raveform_candidates, score_raveform, summarise_raveform, 'EDM from DJ mixes, drops marked'),
    'harmonix': (harmonix_candidates, score_harmonix, summarise_harmonix, 'pop/hip-hop/rock, no drops'),
}


def fmt(template, value):
    return '—' if value is None else template.format(value)


def print_report(report, baseline=None):
    for dataset, summary in report['summaries'].items():
        print(f'\n{dataset} — {DATASETS[dataset][3]} (split {report["meta"]["split"]})')
        before = (baseline or {}).get('summaries', {}).get(dataset)
        for key, label, template, better in REPORT[dataset]:
            now = summary.get(key)
            line = f'  {label:48} {fmt(template, now):>7}'
            if before is not None:
                was = before.get(key)
                arrow = ''
                if better and now is not None and was is not None and abs(now - was) > 1e-9:
                    arrow = ' better' if (now - was) * better > 0 else ' worse'
                line += f'   was {fmt(template, was):>7}{arrow}'
            print(line)
        if before is not None:
            ids_now = {r['id'] for r in report['tracks'][dataset]}
            ids_was = {r['id'] for r in baseline['tracks'].get(dataset, [])}
            if ids_now != ids_was:
                print(f'  (not the same tracks: {len(ids_now - ids_was)} new, {len(ids_was - ids_now)} gone — '
                      'the comparison is loose)')


def git_revision():
    try:
        rev = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', 'src'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        return f'{rev}{"+changes" if dirty else ""}'
    except Exception:
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--datasets', nargs='+', choices=sorted(DATASETS), default=['raveform', 'harmonix'])
    parser.add_argument('--tracks', type=int, default=50, help='per dataset')
    parser.add_argument('--seed', type=int, default=7)
    parser.add_argument('--split', choices=('tune', 'test', 'all'), default='tune')
    parser.add_argument('--save', type=Path, help='write this run (summary and every track) as JSON')
    parser.add_argument('--compare', type=Path, help='a run saved with --save: score its tracks again, and print '
                        'each number beside what it was')
    parser.add_argument('--fresh', action='store_true', help='ignore the stage cache')
    parser.add_argument('--retry-unavailable', action='store_true', help='try the videos noted as gone again')
    args = parser.parse_args(argv)

    # A comparison is only a comparison on the same tracks: the baseline's, in
    # its split and draw, rather than whichever downloads happen to work today.
    baseline = json.loads(args.compare.read_text()) if args.compare else None
    if baseline:
        args.split, args.seed = baseline['meta']['split'], baseline['meta']['seed']
    key = stage_key()
    report = {
        'meta': {'revision': git_revision(), 'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'split': args.split,
                 'seed': args.seed, 'tracks': args.tracks, 'stageKey': key,
                 'dynamicsConfig': repr(DEFAULT.dynamics)},
        'summaries': {}, 'tracks': {},
    }
    for dataset in args.datasets:
        candidates, score, summarise, _ = DATASETS[dataset]
        _, gone = unavailable(dataset)
        wanted = {r['id'] for r in baseline['tracks'].get(dataset, [])} if baseline else None
        limit = len(wanted) if wanted else args.tracks
        rows = []
        for candidate in candidates(args.split, args.seed):
            if len(rows) >= limit:
                break
            if wanted is not None and candidate['id'] not in wanted:
                continue
            if wanted is None and candidate['id'] in gone and not args.retry_unavailable:
                continue
            try:
                path = download(candidate)
                length = soundfile.info(str(path)).duration
                if abs(length - candidate['duration']) > LENGTH_TOLERANCE[dataset]:
                    raise Gone(f'{length:.0f} s here, {candidate["duration"]:.0f} s annotated: another version')
                duration, dyn, beats, seconds, from_cache = analyse(candidate, path, key, args.fresh)
            except Gone as exc:
                mark_unavailable(dataset, candidate['id'], str(exc))
                log(f'{dataset} {candidate["id"]}: skipped for good ({exc})')
                continue
            except Exception as exc:  # a network error or a bot check: try again next run
                log(f'{dataset} {candidate["id"]}: skipped ({type(exc).__name__}: {exc})')
                continue
            row = {'id': candidate['id'], 'title': candidate['title'], 'genre': candidate['genre'],
                   **score(candidate, (duration, dyn))}
            if dataset == 'raveform':
                lag = beat_lag(beats, raveform_beats(candidate['track']), row['beat'])
                row['beatLagMs'] = None if lag is None else round(lag * 1000)
            rows.append(row)
            log(f'{dataset} {len(rows):>3}/{limit} {candidate["title"][:60]:60} '
                f'{len(row["drops"])} drops ({row["proper"]} proper)'
                + (f', {len(row["refDrops"])} marked' if 'refDrops' in row else '')
                + f', {len(row["builds"])} build-ups  [{seconds:.1f} s{" cached" if from_cache else ""}]')
        if not rows:
            log(f'{dataset}: nothing was scored')
            continue
        report['tracks'][dataset] = rows
        report['summaries'][dataset] = summarise(rows)

    if not report['summaries']:
        return 1
    print_report(report, baseline)
    lags = [r['beatLagMs'] for r in report['tracks'].get('raveform', []) if r.get('beatLagMs') is not None]
    if lags:
        print(f'\n  raveform audio against the annotation: beats {np.median(np.abs(lags)):.0f} ms apart (median), '
              f'{sum(abs(x) > 80 for x in lags)} tracks past 80 ms')
    if args.save:
        args.save.write_text(json.dumps(report, indent=1))
        print(f'\nsaved to {args.save}')
    return 0



if __name__ == '__main__':
    sys.exit(main())
