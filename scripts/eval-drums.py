#!/usr/bin/env python3
"""
How well the pulse's drum lanes find the kick, the snare and the hats in real
drumming, scored against hand-marked hits.

    python scripts/eval-drums.py                      every track, all three paths
    python scripts/eval-drums.py --paths drums mix    skip the separator
    python scripts/eval-drums.py --split test         MIREX 2017's test half only

The music is MDB Drums (Southall et al., 2017): 23 excerpts from MedleyDB, from
jazz and reggae to punk and metal, each with its drum track on its own, the full
mix, and every hit marked by instrument. CC BY-NC-SA 4.0; fetched at run time
into ~/.cache/artnet-lightshow/eval/mdb-drums and never redistributed.

Three ways the analyser can hear the drums, scored separately:

    drums   the drum track alone: the lanes' own ceiling, and what a perfect
            separator would hand them
    stems   the full mix through the separator the analyser runs (Demucs),
            its drum stem: what a track analysed with separation gets
    mix     the full mix's percussive half (HPSS): what a track analysed
            without separation gets

For each lane it reports precision, recall and F-measure within ±50 ms (the
MIREX drum-transcription tolerance), summed over every hit of every track in
the split, against two references:

    strict  the dataset's classes: every kick, every snare stroke, every
            hi-hat including the foot's
    marked  the hits a light should mark: the snare without its ghost notes
            and the hi-hat without the pedal's chick — both played quiet on
            purpose, and a third of the snare strokes in these recordings.
            A lane firing on one of them is not counted against it either.

A hat lane that fires on a ride or a crash counts as a false hit in both.

The separator's stems are cached, so a second run re-scores in seconds.
"""

import argparse
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from analysis import preprocess, pulse  # noqa: E402

RAW = 'https://raw.githubusercontent.com/CarlSouthall/MDBDrums/master/MDB%20Drums'
CACHE = Path(os.environ.get('ARTNET_EVAL_DIR', Path.home() / '.cache' / 'artnet-lightshow' / 'eval')) / 'mdb-drums'

# MIREX 2017's halves: the first to tune on, the second to report.
TRAIN = ['80sRock', 'BebopJazz', 'Britpop', 'CoolJazz', 'Disco', 'FunkJazz', 'FusionJazz',
         'Reggae', 'Rock', 'Rockabilly', 'Shadows', 'Zeppelin']
TEST = ['Beatles', 'Country1', 'FreeJazz', 'Gospel', 'Grunge', 'Hendrix', 'LatinJazz',
        'ModalJazz', 'Punk', 'SpeedMetal', 'SwingJazz']

# The dataset's classes, as the lanes name them.
CLASSES = {'KD': 'kick', 'SD': 'snare', 'HH': 'hats'}
TOLERANCE = 0.05


def fetch(url, path):
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'artnet-lightshow eval-drums'})
    with urllib.request.urlopen(request, timeout=300) as response:
        data = response.read()
    path.write_bytes(data)
    return path


def files(name):
    track = f'MusicDelta_{name}'
    q = urllib.parse.quote
    return {
        'drums': fetch(f'{RAW}/audio/drum_only/{q(track)}_Drum.wav', CACHE / 'drum_only' / f'{track}.wav'),
        'mix': fetch(f'{RAW}/audio/full_mix/{q(track)}_MIX.wav', CACHE / 'full_mix' / f'{track}.wav'),
        'labels': fetch(f'{RAW}/annotations/class/{q(track)}_class.txt', CACHE / 'class' / f'{track}.txt'),
        'subclass': fetch(f'{RAW}/annotations/subclass/{q(track)}_subclass.txt', CACHE / 'subclass' / f'{track}.txt'),
    }


# Played quiet on purpose: the snare's ghost notes and the hi-hat's pedal.
QUIET = {'SDG', 'PHH'}


def reference(paths):
    """
    {lane: sorted onset times} from a track's annotations: the strict lanes
    (`kick`, `snare`, `hats`) and the marked ones (`kick`, `snare!`,
    `hats!`), with the quiet strokes (`quiet`) the marked lanes neither
    need nor mind.
    """
    out = {'kick': [], 'snare': [], 'hats': [], 'snare!': [], 'hats!': [], 'quiet-snare': [], 'quiet-hats': []}
    for line in paths['labels'].read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].strip() in CLASSES:
            out[CLASSES[parts[1].strip()]].append(float(parts[0]))
    for line in paths['subclass'].read_text().splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        t, label = float(parts[0]), parts[1].strip()
        lane = 'snare' if label.startswith('SD') else 'hats' if label.endswith('HH') else None
        if lane:
            out[f'quiet-{lane}' if label in QUIET else f'{lane}!'].append(t)
    return {lane: np.array(sorted(times)) for lane, times in out.items()}


def matches(ref, est, tolerance=TOLERANCE, ignore=()):
    """
    Hits matched one to one within `tolerance`: (matched, estimated,
    reference). An estimate within `tolerance` of an `ignore` hit and of no
    reference hit is left out of the count.
    """
    ref = np.asarray(ref, dtype=float)
    est = np.asarray(est, dtype=float)
    ignore = np.asarray(ignore, dtype=float)
    if len(est) and len(ignore):
        near_ignored = np.min(np.abs(est[:, None] - ignore[None, :]), axis=1) <= tolerance
        near_ref = (np.min(np.abs(est[:, None] - ref[None, :]), axis=1) <= tolerance) if len(ref) else np.zeros(len(est), bool)
        est = est[~near_ignored | near_ref]
    if not len(ref) or not len(est):
        return 0, len(est), len(ref)
    from scipy.optimize import linear_sum_assignment
    distance = np.abs(ref[:, None] - est[None, :])
    cost = np.where(distance <= tolerance, distance, 1e6)
    r, c = linear_sum_assignment(cost)
    return int(np.sum(cost[r, c] < 1e6)), len(est), len(ref)


def separated_drums(name, audio):
    """The separator's drum stem for the mix, cached beside the audio."""
    path = CACHE / 'stems' / f'{name}.npy'
    if path.exists():
        drums = np.load(path)
        if drums.size == audio.mono.size:
            return drums
    from analysis import stems
    separated = stems.separate(audio.mono, audio.sample_rate,
                               stereo_loader=lambda rate: preprocess.load_for_separation(audio, rate))
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, separated.drums)
    return separated.drums


def signals(name, paths):
    """{path: (signal, rate)} for the ways of hearing the drums asked for."""
    f = files(name)
    out = {}
    if 'drums' in paths:
        drums = preprocess.prepare(str(f['drums']))
        out['drums'] = (drums.mono, drums.sample_rate)
    if 'mix' in paths or 'stems' in paths:
        mix = preprocess.prepare(str(f['mix']))
        if 'stems' in paths:
            out['stems'] = (separated_drums(name, mix), mix.sample_rate)
        if 'mix' in paths:
            out['mix'] = (mix.percussive, mix.sample_rate)
    return out, reference(f)


LANES = ('kick', 'snare', 'hats', 'snare!', 'hats!')


def tally(totals, ref, found):
    """Add one track's hits to `totals`: {lane: [matched, estimated, reference]}."""
    for lane in LANES:
        base = lane.rstrip('!')
        ignore = ref[f'quiet-{base}'] if lane.endswith('!') else ()
        for k, v in enumerate(matches(ref[lane], found[base]['t'], ignore=ignore)):
            totals[lane][k] += v


def score(tracks, paths, detector=pulse.lanes, quiet=False):
    """{path: {lane: [matched, estimated, reference]}} summed over `tracks`."""
    totals = {p: {lane: [0, 0, 0] for lane in LANES} for p in paths}
    for name in tracks:
        heard, ref = signals(name, paths)
        for path, (signal, rate) in heard.items():
            tally(totals[path], ref, detector(signal, rate))
        if not quiet:
            print(f'{name}: done', file=sys.stderr, flush=True)
    return totals


def prf(matched, estimated, ref):
    p = matched / estimated if estimated else 0.0
    r = matched / ref if ref else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def report(totals, title):
    print(f'\n{title}')
    print(f'{"":8} {"lane":8} {"P":>6} {"R":>6} {"F":>6}   hits   (! the hits a light should mark)')
    for path, lanes in totals.items():
        for lane, (m, e, r) in lanes.items():
            p, rc, f = prf(m, e, r)
            print(f'{path:8} {lane:8} {p:6.2f} {rc:6.2f} {f:6.2f}   {r}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--paths', nargs='+', default=['drums', 'stems', 'mix'], choices=['drums', 'stems', 'mix'])
    parser.add_argument('--split', default='both', choices=['train', 'test', 'both'])
    args = parser.parse_args(argv)
    splits = {'train': TRAIN, 'test': TEST} if args.split == 'both' else {args.split: TRAIN if args.split == 'train' else TEST}
    for split, tracks in splits.items():
        report(score(tracks, args.paths), f'{split} ({len(tracks)} tracks), ±{int(TOLERANCE * 1000)} ms')
    return 0


if __name__ == '__main__':
    sys.exit(main())
