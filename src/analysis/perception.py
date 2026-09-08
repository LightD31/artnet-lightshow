"""
Stage 7 — what the track *feels* like.

Everything up to here is measurement. This stage is interpretation, and it is
where the show's personality comes from: the same drop should look different in
a trance track and in a ballad, and nothing in the signal says which is which
without an opinion about what the numbers mean.

Three outputs:

  key / scale     Krumhansl-Schmuckler correlation against the chroma profile.
                  Drives palette selection, so that two songs in the same key
                  reach for the same colours and a modulation is visible.
  mood            valence and arousal on Russell's circumplex, plus the two
                  derived measures a lighting desk actually wants:
                  danceability and "kickiness".
  genre / style   AudioSet tags folded into a subgenre, and the subgenre folded
                  into one of four show styles. The style is the single most
                  consequential number in the whole document — it decides
                  whether the rig strobes at all.

Each has a documented fallback: no chroma means no key (and a neutral palette),
no tagger means the style comes from tempo and arousal instead. Nothing here
can fail the analysis.
"""

from dataclasses import dataclass, field

import numpy as np

from . import dsp


# Krumhansl-Kessler key profiles: how strongly each scale degree is used in
# major and minor tonality, measured from listener ratings.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                          2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                          2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


# AudioSet labels grouped into the subgenres the show engine has looks for.
SUBGENRES = {
    'edm':       ['electronic dance music', 'house music', 'techno',
                  'dance music', 'electronica', 'electronic music'],
    'dubstep':   ['dubstep', 'drum and bass'],
    'trance':    ['trance music'],
    'disco':     ['disco'],
    'hiphop':    ['hip hop music', 'rapping'],
    'rock':      ['rock music', 'rock and roll', 'progressive rock',
                  'psychedelic rock', 'grunge', 'independent music'],
    'metal':     ['heavy metal', 'punk rock', 'noise music'],
    'pop':       ['pop music'],
    'funk':      ['funk', 'soul music', 'rhythm and blues'],
    'reggae':    ['reggae', 'ska'],
    'country':   ['country', 'bluegrass'],
    'latin':     ['music of latin america', 'salsa music', 'cumbia, quebradita',
                  'reggaeton', 'bossa nova', 'flamenco'],
    'jazz':      ['jazz', 'blues', 'swing music'],
    'classical': ['classical music', 'opera', 'choir', 'orchestra'],
    'folk':      ['folk music', 'acoustic guitar', 'traditional music',
                  'middle eastern music'],
    'ambient':   ['ambient music', 'new-age music', 'gospel music',
                  'christian music', 'piano'],
}

# Show style per subgenre. This is the contract with the show engine:
#   dance     strobes, chases, hard cuts, fast beat divisions
#   moderate  bursts and movement, strobes reserved for drops
#   rock      strong beats and colour changes, sparing effects
#   calm      fades and gradients only, no strobes at any intensity
GENRE_STYLE = {
    'edm': 'dance', 'dubstep': 'dance', 'trance': 'dance', 'disco': 'dance',
    'hiphop': 'moderate', 'pop': 'moderate', 'funk': 'moderate',
    'rock': 'rock', 'metal': 'rock', 'country': 'rock', 'reggae': 'rock',
    'jazz': 'calm', 'classical': 'calm', 'folk': 'calm', 'ambient': 'calm',
    'latin': 'calm',
}


@dataclass
class Perception:
    key: str = None
    scale: str = None
    key_strength: float = 0.0
    valence: float = 0.5
    arousal: float = 0.5
    danceability: float = 0.5
    kickiness: float = 0.5
    tension: float = 0.5
    genre: str = 'unknown'
    genre_confidence: float = 0.0
    style: str = 'unknown'
    subgenre_scores: dict = field(default_factory=dict)
    top_tags: list = field(default_factory=list)
    #: Raw AudioSet probabilities, for the band stage. Not serialised.
    tags: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            'key': self.key,
            'scale': self.scale,
            'keyStrength': round(self.key_strength, 3),
            'mood': {
                'valence': round(self.valence, 3),
                'arousal': round(self.arousal, 3),
                'danceability': round(self.danceability, 3),
                'kickiness': round(self.kickiness, 3),
                'tension': round(self.tension, 3),
            },
            'genre': {
                'label': self.genre,
                'confidence': round(self.genre_confidence, 3),
                'style': self.style,
                'subScores': {k: round(v, 3) for k, v in self.subgenre_scores.items()},
                'topTags': self.top_tags,
            },
        }


# ── Key ─────────────────────────────────────────────────────────────────────

def estimate_key(chroma):
    """
    Correlate the track's average chroma against all 24 rotated key profiles.

    Returns (key, scale, strength). Strength is the margin between the best fit
    and the second best, not the raw correlation: a track that fits C major at
    0.9 and A minor at 0.89 has an ambiguous key, and the palette should not act
    as if it were certain.
    """
    if chroma is None or getattr(chroma, 'size', 0) == 0:
        return None, None, 0.0
    profile = np.mean(np.asarray(chroma, dtype=float), axis=1)
    if profile.size != 12 or np.sum(profile) <= 0:
        return None, None, 0.0
    profile = profile / np.sum(profile)

    scores = []
    for tonic in range(12):
        for name, template in (('major', MAJOR_PROFILE), ('minor', MINOR_PROFILE)):
            rotated = np.roll(template, tonic)
            rotated = rotated / np.sum(rotated)
            if np.std(rotated) < 1e-9 or np.std(profile) < 1e-9:
                continue
            correlation = float(np.corrcoef(profile, rotated)[0, 1])
            if np.isfinite(correlation):
                scores.append((correlation, tonic, name))
    if not scores:
        return None, None, 0.0

    scores.sort(reverse=True)
    best, tonic, scale = scores[0]
    runner_up = scores[1][0] if len(scores) > 1 else 0.0
    strength = dsp.clamp01(max(0.0, best) * (0.5 + 0.5 * max(0.0, best - runner_up) * 4))
    return KEY_NAMES[tonic], scale, round(strength, 3)


# ── Mood ────────────────────────────────────────────────────────────────────

def estimate_mood(features, bands, rhythm, scale, key_strength, roles=None):
    """
    Valence and arousal, plus the two measures a lighting desk actually uses.

    Arousal is the easy one and the reliable one: loudness, brightness,
    rhythmic density and tempo all point the same way, and it is what decides
    how hard the rig works.

    Valence is the hard one. Mode (major/minor) is the strongest single cue and
    it is weak — plenty of minor-key music is joyful — so it is weighted by how
    confident the key estimate was, and blended with brightness and harmonic
    consonance rather than trusted on its own. The number it produces is a hue
    bias, never a decision on its own.
    """
    tempo = rhythm.bpm if rhythm.bpm > 0 else 120.0

    loudness = dsp.clamp01(float(np.mean(dsp.robust_norm(features.rms))) * 1.4)
    brightness = dsp.clamp01(
        float(np.mean(features.centroid)) / max(1.0, features.sample_rate / 6.0))
    density = dsp.clamp01(float(np.mean(rhythm.intensity)) * 1.3) \
        if rhythm.intensity.size else 0.5
    tempo_drive = dsp.clamp01((tempo - 60.0) / 110.0)

    arousal = dsp.clamp01(
        0.30 * loudness + 0.22 * density + 0.26 * tempo_drive + 0.22 * brightness)

    mode_bias = 0.0
    if scale == 'major':
        mode_bias = 0.5 * key_strength
    elif scale == 'minor':
        mode_bias = -0.5 * key_strength
    consonance = 1.0 - dsp.clamp01(float(np.mean(features.flatness)) * 6.0)
    valence = dsp.clamp01(
        0.5 + 0.30 * mode_bias + 0.22 * (brightness - 0.45) + 0.18 * (consonance - 0.5))

    # Danceability: a steady grid you can move to. Beat confidence carries most
    # of it — music you cannot find the beat of is not danceable however fast
    # it is — with a tempo window on top, because 190 BPM and 60 BPM are both
    # hard to dance to for opposite reasons.
    beat_confidence = float(np.mean(rhythm.confidences)) if rhythm.confidences.size else 0.0
    tempo_fit = float(np.exp(-0.5 * ((tempo - 122.0) / 38.0) ** 2))
    danceability = dsp.clamp01(
        0.40 * beat_confidence + 0.25 * tempo_fit
        + 0.20 * rhythm.stability + 0.15 * density)

    # Kickiness: is the low end punching or sustaining? This is the number that
    # decides whether the rig hits on the beat or breathes across the bar.
    #
    # Read off the *kick role*, not the raw bass band: the bass band contains
    # the bass line as well, and on any track with a sustained sub the band's
    # own percussive ratio reports the bass line rather than the drum.
    kick_band = bands.get('bass')
    kickiness = 0.5
    if kick_band is not None:
        tight_attack = 1.0 - dsp.clamp01((kick_band.attack_ms - 10.0) / 90.0)
        kickiness = dsp.clamp01(
            0.35 * kick_band.rhythmic + 0.25 * kick_band.percussive_ratio
            + 0.20 * tight_attack
            + 0.20 * (roles.scores.get('kick', 0.5) if roles is not None else 0.5))

    # Tension: bright, noisy, dense and *un*resolved. Rises through build-ups.
    tension = dsp.clamp01(
        0.35 * brightness + 0.30 * dsp.clamp01(float(np.mean(features.flatness)) * 5.0)
        + 0.35 * (1.0 - float(np.mean(rhythm.confidences)) if rhythm.confidences.size else 0.5))

    return {
        'valence': valence, 'arousal': arousal, 'danceability': danceability,
        'kickiness': kickiness, 'tension': tension,
    }


# ── Genre ───────────────────────────────────────────────────────────────────

def classify_genre(tags, mood, rhythm):
    """
    Fold AudioSet probabilities into a subgenre and a show style.

    Falls back to tempo and arousal when there are no tags. The fallback is
    deliberately conservative — it will call a track `unknown` and let the show
    engine use arousal directly rather than guess a genre and light a ballad
    like a rave.
    """
    if not tags:
        return _style_from_signal(mood, rhythm)

    scores = {}
    for name, labels in SUBGENRES.items():
        scores[name] = float(sum(tags.get(label, 0.0) for label in labels))

    label, confidence = max(scores.items(), key=lambda kv: kv[1])
    if confidence < 0.08:
        fallback = _style_from_signal(mood, rhythm)
        fallback['subgenre_scores'] = scores
        fallback['top_tags'] = _top_tags(tags)
        return fallback

    return {
        'genre': label,
        'genre_confidence': dsp.clamp01(confidence),
        'style': GENRE_STYLE.get(label, 'moderate'),
        'subgenre_scores': scores,
        'top_tags': _top_tags(tags),
    }


def _top_tags(tags, count=6):
    ordered = sorted(tags.items(), key=lambda kv: -kv[1])[:count]
    return [{'label': label, 'p': round(float(p), 3)} for label, p in ordered]


def _style_from_signal(mood, rhythm):
    """
    Style without a classifier: tempo, arousal and how steady the beat is.

    Not a genre guess — it returns `unknown` for the label, because saying
    "this is house" from a tempo is how a live band gets lit like a DJ set. It
    only commits to how hard the rig should work.
    """
    arousal = mood['arousal']
    dance = mood['danceability']
    tempo = rhythm.bpm

    if arousal >= 0.72 and dance >= 0.60 and 110 <= tempo <= 180:
        style = 'dance'
    elif arousal >= 0.62:
        style = 'moderate'
    elif arousal >= 0.42:
        style = 'rock'
    else:
        style = 'calm'
    return {
        'genre': 'unknown',
        'genre_confidence': 0.0,
        'style': style,
        'subgenre_scores': {},
        'top_tags': [],
    }


# ── Entry point ─────────────────────────────────────────────────────────────

def analyse(features, bands, rhythm, roles=None, tags=None) -> Perception:
    key, scale, strength = estimate_key(features.chroma)
    mood = estimate_mood(features, bands, rhythm, scale, strength, roles)
    genre = classify_genre(tags, mood, rhythm)
    return Perception(
        key=key, scale=scale, key_strength=strength,
        valence=mood['valence'], arousal=mood['arousal'],
        danceability=mood['danceability'], kickiness=mood['kickiness'],
        tension=mood['tension'],
        genre=genre['genre'], genre_confidence=genre['genre_confidence'],
        style=genre['style'], subgenre_scores=genre['subgenre_scores'],
        top_tags=genre['top_tags'], tags=tags or {},
    )
