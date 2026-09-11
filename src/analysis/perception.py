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
  genre / style   MuQ-MuLan scored against the sixteen subgenres by name, and
                  the subgenre folded into one of four show styles. The style is
                  the single most consequential number in the whole document —
                  it decides whether the rig strobes at all.

Each has a documented fallback: no chroma means no key (and a neutral palette),
no classifier means the style comes from tempo and arousal instead. Nothing
here can fail the analysis.
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


# Zero-shot genre prompts for MuQ-MuLan, which is what actually answers the
# genre question now.
#
# The point of a joint music/text embedding is that the classes are whatever
# you ask it for, so these prompts *are* the sixteen subgenres the show engine
# knows about. The AudioSet fold below had to work the other way round — guess
# that `independent music` means rock, that `flamenco` means latin, that a
# close vocal harmony tagged `christian music` does not mean gospel — and that
# fold is where its wrong answers came from, not the model's confidence.
#
# Several phrasings per subgenre, scored by their best match. One phrasing can
# miss for reasons that have nothing to do with the music ("disco" is also a
# room, "country" is also a place), and asking three ways costs one text-tower
# pass over 40-odd short strings while the audio is encoded exactly once.
GENRE_PROMPTS = {
    'edm':       ('electronic dance music', 'house music',
                  'a four to the floor club track'),
    'dubstep':   ('dubstep', 'drum and bass', 'bass music with a heavy drop'),
    'trance':    ('trance music', 'uplifting trance with a long build-up'),
    'disco':     ('disco music', 'seventies disco with strings and four to the floor'),
    'hiphop':    ('hip hop music', 'rap over a beat', 'trap music'),
    'rock':      ('rock music', 'a rock band with electric guitars, bass and drums',
                  'indie rock'),
    'metal':     ('heavy metal', 'punk rock', 'aggressive distorted guitars and screamed vocals'),
    'pop':       ('pop music', 'a mainstream pop song with a sung chorus'),
    'funk':      ('funk music', 'soul and rhythm and blues', 'a funky groove with a slap bass'),
    'reggae':    ('reggae', 'ska', 'dub with an off-beat guitar skank'),
    'country':   ('country music', 'bluegrass', 'americana with acoustic guitar and fiddle'),
    'latin':     ('latin music', 'salsa, cumbia and reggaeton',
                  'brazilian music with bossa nova guitar'),
    'jazz':      ('jazz', 'blues', 'a swinging jazz combo with an upright bass'),
    'classical': ('classical music', 'an orchestra playing', 'opera and choral music'),
    'folk':      ('folk music', 'traditional acoustic music', 'a singer with an acoustic guitar'),
    'ambient':   ('ambient music', 'a slow atmospheric drone with no beat'),
}

# Cosine similarities are not probabilities, and the thresholds below are
# written against a distribution: a softmax is what makes them comparable.
#
# The temperature is the only free parameter in the transform, and it is set by
# where it puts `GENRE_MIN_SCORE`. With sixteen classes an undecided model sits
# at 1/16 = 0.06, comfortably under the 0.15 floor, so it falls through to the
# signal — which is what the floor is for. At 0.1 the floor then lands almost
# exactly on a best prompt leading the field by 0.10 of a cosine: below that the
# model is not saying much, and a 0.3 lead comes out at 0.57. Lower it and
# near-ties start deciding shows; raise it and only a certainty gets a label.
#
# Note which of the two thresholds is load-bearing here. After a softmax the
# margin is the weaker one — `GENRE_MIN_MARGIN` of 1.5 is only 0.04 of a cosine
# between the top two — because the floor already encodes "leads the whole
# field". On the AudioSet path below, where the scores are unnormalised sums,
# it is the other way round and the margin is what catches a four-way tie.
GENRE_SOFTMAX_TEMPERATURE = 0.1

# AudioSet labels grouped into the subgenres the show engine has looks for.
#
# The fallback path, kept for rigs that have `panns_inference` installed but no
# MuQ-MuLan checkpoint. See `GENRE_PROMPTS` above for why it is second choice:
# a general-audio tagger has to be folded into musical categories, and the fold
# is lossy in exactly the places a lighting desk cares about.
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
    # `piano`, `gospel music` and `christian music` used to sit here. They are
    # not genres in any sense the rig cares about — a piano appears in ballads,
    # jazz and hip hop alike, and AudioSet fires `christian music` on close
    # vocal harmony. Together they were enough to carry a Backstreet Boys track
    # to `ambient`, and from there to the `calm` tier, which turns the whole
    # show off. A label that does not predict how to light a track does not
    # belong in a bucket that does.
    'ambient':   ['ambient music', 'new-age music'],
}

# How sure the classifier has to be before its answer is allowed to set the
# show's style, and by how much it has to beat the runner-up.
#
# The old floor of 0.08 with no margin let a four-way statistical tie decide:
# on one track `ambient` won at 0.108 over `funk` at 0.105 — a three-percent
# margin — and that coin toss put the track in the `calm` tier for its whole
# duration. Below these thresholds the answer is noise and the signal-derived
# style is the more honest one.
GENRE_MIN_SCORE = 0.15
GENRE_MIN_MARGIN = 1.5

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
    #: Which classifier produced the label: `muq-mulan`, `panns` or `signal`.
    genre_source: str = 'signal'
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
                # The web client reads `labelConf`. Kept alongside the clearer
                # name rather than renamed, because cached documents carry
                # whichever one was current when they were written.
                'labelConf': round(self.genre_confidence, 3),
                'style': self.style,
                'source': self.genre_source,
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

def genre_prompts():
    """Every zero-shot prompt in one flat tuple, for the model adapter."""
    return tuple(prompt for prompts in GENRE_PROMPTS.values() for prompt in prompts)


def subgenre_scores_from_prompts(rows):
    """
    Fold zero-shot prompt similarities into one probability per subgenre.

    Each subgenre takes its best-matching prompt — a maximum rather than a mean,
    because a prompt that misses drags an average down without carrying any
    information, and only one phrasing has to land for the answer to be right.
    """
    similarity = {row['label']: float(row['score']) for row in rows or []
                  if isinstance(row, dict) and 'label' in row and 'score' in row}
    if not similarity:
        return {}
    best = {}
    for name, prompts in GENRE_PROMPTS.items():
        matched = [similarity[prompt] for prompt in prompts if prompt in similarity]
        if matched:
            best[name] = max(matched)
    if not best:
        return {}
    names = list(best)
    values = np.array([best[name] for name in names], dtype=float)
    if not np.all(np.isfinite(values)):
        return {}
    weights = np.exp((values - values.max()) / GENRE_SOFTMAX_TEMPERATURE)
    weights /= weights.sum()
    return {name: float(weight) for name, weight in zip(names, weights)}


def classify_genre(tags, mood, rhythm, genre_scores=None):
    """
    Decide a subgenre and a show style, from the best evidence available.

    Three tiers, in order: MuQ-MuLan's zero-shot scores over the subgenres
    themselves, then AudioSet tags folded into those subgenres, then tempo and
    arousal. The last is deliberately conservative — it will call a track
    `unknown` and let the show engine use arousal directly rather than guess a
    genre and light a ballad like a rave.
    """
    scores = subgenre_scores_from_prompts(genre_scores)
    source = 'muq-mulan'
    if not scores and tags:
        scores = {name: float(sum(tags.get(label, 0.0) for label in labels))
                  for name, labels in SUBGENRES.items()}
        source = 'panns'
    if not scores:
        return _style_from_signal(mood, rhythm)

    result = decide_genre(scores, mood, rhythm)
    result['subgenre_scores'] = scores
    # The tag list is what the operator sees when the label looks wrong, so it
    # shows the evidence that was actually used: AudioSet classes for the fold,
    # the subgenre distribution itself for the zero-shot pass.
    result['top_tags'] = _top_tags(tags if source == 'panns' else scores)
    if result['genre_source'] == 'scores':
        result['genre_source'] = source
    return result


def decide_genre(scores, mood, rhythm):
    """
    Turn subgenre scores into a label and a show style.

    Split out from the tagging so the decision can be tested against the scores
    real tracks actually produced, without a 310 MB model in the loop.

    Two guards, both there because of the same asymmetry: of the four styles,
    `calm` is the only one that turns the show *off* — no strobes, no drops, no
    accents — so a wrong `calm` costs the whole track, while a wrong `dance`
    merely over-lights it. The thresholds and the veto below are not symmetric
    for that reason.
    """
    if not scores:
        return _style_from_signal(mood, rhythm)

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    label, confidence = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0.0

    confident = (confidence >= GENRE_MIN_SCORE
                 and confidence >= runner_up * GENRE_MIN_MARGIN)
    if not confident:
        return _style_from_signal(mood, rhythm)

    style = GENRE_STYLE.get(label, 'moderate')

    # The veto. Even a confident tag does not get to call a track calm when the
    # signal is plainly saying otherwise: a loud, danceable track lit as a
    # ballad is the most visible failure the show engine has, and arousal and
    # danceability are measured rather than inferred.
    if style == 'calm' and mood['arousal'] >= 0.70 and mood['danceability'] >= 0.60:
        style = _style_from_signal(mood, rhythm)['style']

    return {
        'genre': label,
        'genre_confidence': dsp.clamp01(confidence),
        # Overwritten by `classify_genre` with the classifier that produced the
        # scores; `decide_genre` deliberately does not know which one that was.
        'genre_source': 'scores',
        'style': style,
        'subgenre_scores': {},
        'top_tags': [],
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
        'genre_source': 'signal',
        'style': style,
        'subgenre_scores': {},
        'top_tags': [],
    }


# ── Entry point ─────────────────────────────────────────────────────────────

def analyse(features, bands, rhythm, roles=None, tags=None,
            genre_scores=None) -> Perception:
    key, scale, strength = estimate_key(features.chroma)
    mood = estimate_mood(features, bands, rhythm, scale, strength, roles)
    genre = classify_genre(tags, mood, rhythm, genre_scores)
    return Perception(
        key=key, scale=scale, key_strength=strength,
        valence=mood['valence'], arousal=mood['arousal'],
        danceability=mood['danceability'], kickiness=mood['kickiness'],
        tension=mood['tension'],
        genre=genre['genre'], genre_confidence=genre['genre_confidence'],
        genre_source=genre['genre_source'],
        style=genre['style'], subgenre_scores=genre['subgenre_scores'],
        top_tags=genre['top_tags'], tags=tags or {},
    )
