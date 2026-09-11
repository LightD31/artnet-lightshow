# Audio analysis and the show engine

How a music file becomes a lighting show, what each stage does, which numbers
you can turn, and where to add your own.

The short version:

```
audio file
    │
    ▼
┌───────────────────────────────────────────┐
│  src/analysis/   (Python)                 │
│                                           │
│  preprocess → features → bands            │
│                  │                        │
│                  ├→ rhythm → structure    │
│                  ├→ dynamics              │
│                  └→ perception            │
│                         │                 │
│                         ▼                 │
│                  MUSICAL EVENTS           │
└───────────────────────────────────────────┘
    │  analysis document (JSON, cached on disk)
    ▼
┌───────────────────────────────────────────┐
│  src/show/       (Node)                   │
│                                           │
│  musical-events → director → render       │
│                      │                    │
│                      ▼                    │
│               LIGHTING INTENTS            │
└───────────────────────────────────────────┘
    │  patches
    ▼
src/server/engine.js → Art-Net / sACN
```

The two indirections are the point of the design.

**Musical events** exist so the lighting side never touches a spectrogram. A
direct audio-to-DMX mapping can only really express "louder means brighter",
and every effect has to re-derive the same facts. An event stream lets the show
reason about music: it can decide to ignore the next four bars because a drop is
coming, because that is a statement about events, not about samples.

**Lighting intents** exist so the director's judgement can be read, tested and
argued with without decoding channel values. `src/show/render.js` is the only
file in the show layer that knows what a patch field is called.

---

## Running it

Before a show, run `npm run preflight`. It downloads the configured pretrained
weights into the local Art-Net model cache from Hugging Face. Set
`ARTNET_MODEL_DIR` to move that cache, or `ARTNET_PYTHON` to select the Python
environment. The RoFormer four-stem checkpoint is published by the community
registry and its redistribution terms must be checked before commercial use.
MuQ and MuQ-MuLan weights are CC-BY-NC 4.0; they are suitable for evaluation
and non-commercial use unless you obtain separate permission.

Set `ARTNET_MUQ_MODEL` and `ARTNET_MUQ_MULAN_MODEL` to the downloaded model
directories to enable those passes. Without these variables the deterministic
analysis path continues to run and playback is never held for model loading.

```bash
# One track to stdout, plus an interactive debug page
python src/analyze.py track.wav --report /tmp/report.html

# What the server runs: a persistent NDJSON worker on stdin/stdout
python src/analyze.py --worker

# Live mode: raw float32 mono PCM in, musical events out as NDJSON
python src/analyze.py --live --rate 22050 < stream.raw
```

The worker protocol is one JSON object per line each way:

```json
→ {"id": 7, "source": "/tmp/track.wav", "targetDurationSec": 238.0}
← {"id": 7, "result": { ...analysis document... }}
← {"id": 7, "error": "File not found: /tmp/track.wav"}
```

One request in flight at a time — the analysis already saturates the CPU across
BLAS and its own thread pools, so serving two would make both slower.
`src/analyzer-worker.js` owns the queue, the priority ordering and the timeout.

---

## Stage 1 — preprocessing (`preprocess.py`, `loudness.py`)

Everything downstream reads thresholds off absolute numbers ("energy above
0.55"). Those numbers only mean something if the input is on a known scale
first.

* **Decode and resample** to 22.05 kHz, keeping both channels. librosa's
  polyphase resampler is genuinely band-limited.
* **Stereo measurements** — width (side/mid RMS) and inter-channel correlation,
  taken before anything is collapsed to mono.
* **Loudness** — ITU-R BS.1770-4, implemented directly in `loudness.py`:
  K-weighting (a high-pass at ~38 Hz and a +4 dB shelf above ~1.7 kHz, both
  re-derived at the actual sample rate rather than using the spec's 48 kHz
  coefficients), 400 ms gating blocks at 75 % overlap, an absolute gate at
  -70 LUFS and a relative gate 10 LU below the ungated mean. The track is then
  normalised to -18 LUFS, capped at 24 dB of make-up gain.

  Why not RMS: RMS says how big the numbers are, LUFS says how loud it sounds,
  and the gating throws away the gaps between phrases so a sparse arrangement is
  not measured as quiet because it has holes in it.
* **Filtering** — a 2nd-order Butterworth high-pass at 18 Hz, then optional
  gentle spectral subtraction. Denoising is gated on *two* conditions, because a
  low SNR alone does not mean noisy audio: a track with no silence in it has no
  quiet frames to estimate a floor from, so its measured SNR comes out low while
  the audio is clean. The second condition is spectral flatness of the estimated
  floor — real hiss measures above 0.9, clean material below 0.25.
* **Adaptive gain control** produces a *second* copy of the signal with a slow
  (3 s window) gain curve dividing out section-level dynamics. The rhythm stage
  reads that copy so a quiet intro gives up its beats as readily as the chorus;
  the feature stages read the untouched one, because the difference between the
  intro and the chorus is the information there. Deliberately slow: a fast AGC
  flattens the very transients the beat tracker is looking for.
* **Harmonic/percussive separation** (median filtering on the spectrogram,
  margin 3.0).
* **Alignment** — when the caller knows the real track length (from a streaming
  service), quiet lead-in and tail are trimmed so the analysis clock and the
  playback clock agree. Half a second of offset here is half a second of every
  cue landing late for the whole song.
* **Wideband pass** at 32 kHz for the `air` band and the tagger, when the source
  has bandwidth above the analysis Nyquist.

## Stage 2 — frame features (`features.py`)

One STFT (2048/512), one time grid, everything else derived from it — so frame
`i` means the same instant to every stage.

| Feature | What it is for in a lighting context |
|---|---|
| RMS / energy | how hard to drive the rig |
| momentary loudness | the same, perceptually weighted |
| spectral centroid | dark and warm vs bright and sharp — the best single input to colour temperature |
| rolloff (85 %, 20 %) | how much top end there really is; separates a muffled verse from an open chorus better than centroid alone |
| spectral flux | how much the spectrum is *changing*; raw material for onsets |
| zero-crossing rate | noisiness — hats and distortion vs tonal content |
| spectral flatness | tonal vs noise-like; risers and crashes read high |
| spectral contrast | peak-to-valley per band; high on clear arrangements |
| chroma (CQT) | harmony, for key and for melody-change detection |

Flux is half-wave rectified: only *increases* in a bin count. A note ending is a
large spectral change and not an onset, and a detector that counts it fires
twice per note.

## Stage 3 — bands and instruments (`bands.py`)

Seven bands, at the split points a mix engineer uses:

| Band | Range | Typically |
|---|---|---|
| `sub` | 20–60 Hz | felt more than heard; 808s, sub drops |
| `bass` | 60–250 Hz | kick body, bass guitar, bass synth |
| `lowmid` | 250–500 Hz | warmth, low vocals, guitar body |
| `mid` | 500 Hz–2 kHz | vocal fundamentals, most melody |
| `presence` | 2–5 kHz | snare crack, vocal intelligibility |
| `high` | 5–12 kHz | hats, cymbals, transient detail |
| `air` | 12 kHz+ | shimmer, reverb tails |

A band's *level* is the least interesting thing about it — mapping level to
brightness is exactly the volume-reactive behaviour this replaces. Each band is
described instead by:

* **attack / decay**, in milliseconds, measured as the median 10→90 % rise and
  90→10 % fall around the band's own peaks. Around peaks rather than globally,
  because the average of a kick band is dominated by the gaps between kicks.
* **variation** — coefficient of variation. A pad sits still; a kick pattern
  swings the whole way every bar.
* **rhythmic correlation** — how much of the band's movement lands on the beat,
  scored against the half-beat positions so an energetic-but-arrhythmic band
  does not score by being busy. 0.5 means no better than chance.
* **importance** — `0.30 × level + 0.30 × movement + 0.40 × rhythmic`, weighted
  away from level because every mastered track has bass energy and ranking by it
  would put the bass band first on literally every song.

**Instrument roles** — kick, bassline, snare, hats, vocal, synth — are read off
**separated sources**. Demucs v4 splits the mix into drums, bass, vocals and
everything else; the kick is then whatever is low and percussive *in the drums
stem*, and the singer is whatever is in the vocals stem. The question stops
being a judgement call: a track with no voice on it has an empty vocals stem.

That replaces a set of rules that existed only to paper over the ambiguity of
looking at the mix as a whole. A sustained synth bass read as a kick, because
both are low and both move. A bright pad read as a voice, because both sit in
the mids and both hold. The rules were tuned against those cases and lost
somewhere else each time.

A role's **score** is the 90th percentile of its curve, scaled by the square
root of its stem's share of the mix. The percentile rather than the mean,
because anything percussive is silent for most of every beat: a kick on every
beat has a mean near 0.16, and scoring by the mean says a track built on that
kick barely has one. The question the show cares about is whether it hits hard
when it hits.

Separation costs roughly 0.6× realtime on CPU and a few seconds on a GPU. Set
`AnalysisConfig(separate_sources=False)` to skip it; roles then fall back to the
band heuristics, which is a documented speed/quality knob rather than a failure
path. AudioSet tags, when available, adjust the *scores* but never the curves: a
missing or wrong tag costs the show nuance, not timing.

## Stage 4 — rhythm (`rhythm.py`)

```
audio → beat model → beat grid → bar grid → tempo
```

**Beats and downbeats come from a model.** [Beat This!][beatthis] (Foscarin et
al., ISMIR 2024) is a transformer that predicts beat and downbeat activations
directly from the spectrogram. It runs without the DBN post-processor, so madmom
is not a dependency: no Cython, no C compiler, no package pinned to a numpy from
2018 — which matters when the person installing this is a VJ on a Windows laptop
rather than a researcher.

[beatthis]: https://github.com/CPJKU/beat_this

This replaced a signal chain — autocorrelation, log-normal tempo prior, harmonic
reinforcement, pulse-train re-ranking, dynamic-programming tracking, low-band
subdivision check — that was carefully built and still reported a 99 BPM pop
song at 198. Every part of it reasons about **periodicity**, and periodicity
genuinely does not distinguish a song counted at 99 from the same song counted
at 198. Both are correct descriptions of the signal. Only one is how the song is
counted, and knowing which requires having heard music. The chain is gone rather
than kept as a fallback: shipping a worse answer under the same field name is
worse than refusing to answer, so a missing model raises `ModelUnavailable` and
names the install command.

Two things are done to the model's raw output:

* **Doubled beats are thinned.** The model peak-picks on a 50 Hz grid, and on a
  strong onset the peak occasionally straddles two frames and comes back as two
  beats an eighth of a beat apart. One such pair in a four-minute track moves
  the reported tempo: the period fit counts beats, so a single extra one
  shortens the fitted period by 1/n and a 140 BPM track is reported at 142. Of a
  too-close pair, the one nearer to where the running period says the beat
  belongs is kept — keeping the earlier one is a coin flip, and on the case that
  exposed this it was the wrong side of the coin.
* **The bar grid is fitted, not read.** The model marks downbeats frame by frame
  with no constraint that bars come out the same length, and on anything it
  finds ambiguous they do not. `decode_downbeats` scores every (metre, phase)
  pair by **precision × recall** against the activations and takes the best, so
  bars are regular by construction. Recall alone would always pick the shortest
  metre, since bar lines every two beats contain every bar line every four;
  precision punishes the empty bar lines that come with it. Candidate metres
  come from `RhythmConfig.meters`, 4 and 3 by default. The reference
  implementation does this with an HMM, which is the part of madmom being
  avoided.

The fit score is reported as `downbeatConfidence`, and it is a real signal:
steady 4/4 dance music scores 1.0, and audio the model is guessing on scores
below 0.4. The show engine accents bars less when it is low, which is the right
behaviour for a track whose bar lines nobody can hear either.

**Tempo** is then whatever the beat grid describes — a least-squares fit through
the whole grid, falling back to the median interval when the fit is loose
(r² ≤ 0.999) because that means the track genuinely moves. The fit matters
because the model's output is quantised to 20 ms: at 140 BPM the individual
intervals are 0.42 or 0.44 against a true 0.4286, and only the rounding pattern
across a hundred beats carries the fraction back.

**Stability** is measured against that tempo rather than used to choose it: how
far local tempo wanders from the grid is a property of the track the show engine
reads.

**Confidence** is per beat, not per track: onset strength blended with how
regular the beat's spacing is. A strong hit off the grid is a fill; a weak beat
exactly where the grid predicted is still a beat and the show can keep counting
through it. A show that knows which beats it is sure of can accent those and let
the rest pass, which is what a human operator does when the mix gets muddy.

## Stage 5 — structure (`structure.py`)

Two questions, answered separately because they need different evidence.

**Where the boundaries are** — beat-synchronous features (chroma, MFCC, band
balance) → recurrence matrix → path enhancement → normalised Laplacian →
spectral clustering, choosing *k* by eigengap. This is McFee & Ellis (2014), and
it is the standard because it finds *repetition*, which is what a section
boundary actually is, rather than loud/quiet changes.

Two additions on top:

* the per-beat labels are **mode-filtered** over about four bars. k-means
  classifies each beat independently, so its raw output flickers bar by bar —
  twenty label changes on a track with four sections — and merging away twenty
  fragments cascades into two sections for the whole song.
* a **Foote checkerboard novelty** curve tops up the boundaries when the
  clustering comes back well under one section per twenty-five seconds. It
  disagrees at the points where the arrangement changes without the harmony
  changing — the drums dropping out, the pad coming in — and those are exactly
  the moments a show has to acknowledge.

**What each section is** cannot come from self-similarity, which only knows that
section 2 and section 5 are the same, never that they are the chorus. That comes
from arrangement convention, stated explicitly in `assign_roles`:

1. a section is a `drop` only when a *proper* drop lands in its first quarter
   and its energy is at or above the track's median. "Contains a drop
   anywhere" is not enough — the detector emits a few drops on every track and
   most sections are long enough to contain one, which labelled five of the
   nine sections of a piano ballad `drop`. This changes only the section's
   label and the energy tier the show gives it; the DROP *event* still fires at
   the same instant and still gets the full gesture;
2. the first section is an `intro` when it is quieter than the median or short
   (a track that opens at full tilt has no intro, and pretending otherwise costs
   the show its first thirty seconds);
3. the last is an `outro` when it is quieter than what precedes it;
4. of the labels that repeat, the highest-energy one is the `chorus`;
5. a low-energy section in the middle third, at least eight seconds long, is a
   `breakdown`;
6. a label appearing exactly once, past the first third, is a `bridge`;
7. everything else is a `verse`.

Sections sharing a label are then reconciled to one role by majority, because a
chorus that lights differently on its second appearance reads as a mistake
rather than as variety. Only `intro` and `outro` are exempt: those are defined
by *position*, and the first section of a track is an intro however much it
resembles the chorus. Everything else — `drop` included — has to agree across a
cluster, because the show engine biases a section's energy tier by its role, so
two appearances of one cluster that disagree get different beat divisions for
identical music.

## Stage 6 — dynamics (`dynamics.py`)

Drops, build-ups, breaks, silences and spikes. All five look alike in an energy
curve if you only measure the slope; what separates them is what happens *after*.
So every detector measures both sides of a transition:

* **drop** — a rise of at least 0.22 of the normalised range, over a bar or two
  that sat at least 0.18 below the new level (the breakdown that makes a drop a
  drop), with the new level still there four seconds later. A cymbal crash rises
  exactly as fast and fails the sustain test. The instant is snapped to the
  nearest downbeat within half a bar. Candidates in the first or last few
  seconds are rejected outright — a drop needs a before and an after, and
  without that rule the fade-in from digital silence at the top of every track
  reads as a textbook drop.
* **build-up** — searched *backwards from a drop*, never independently: a rise
  that does not arrive anywhere is a crescendo, and lighting it like a build-up
  promises a payoff the track never delivers. The start is the point that makes
  the window most like a ramp (best Pearson correlation with time), not the
  earliest point that passes a threshold — a window of "flat verse, then riser"
  passes a threshold and hands back the verse.
* **break** — a sustained fall, clipped at the next drop inside it, because
  after a breakdown the energy comes back up *at* the drop and an unclipped
  break tells the show to stay pulled back for it.
* **silence** — contiguous frames below 0.06, measured on a smoothed curve. The
  raw RMS curve dips to near zero *between* kicks, and an unsmoothed test reports
  several hundred silences in a four-on-the-floor track.
* **spike** — a short excursion 2.2σ above the local baseline. Kept separate
  from drops because it wants a completely different gesture; treating one as a
  drop means the show changes scene for a cymbal.

## Stage 7 — perception (`perception.py`, `tagger.py`)

* **Key** — Krumhansl-Schmuckler correlation against all 24 rotated profiles.
  The reported strength is the *margin* over the runner-up, not the raw
  correlation: a track that fits C major at 0.90 and A minor at 0.89 has an
  ambiguous key and the palette should not act as if it were certain.
* **Mood** — arousal from loudness, rhythmic density, tempo and brightness (the
  reliable one); valence from mode, brightness and consonance, with mode
  weighted by key confidence (the unreliable one — plenty of minor-key music is
  joyful, so the number it produces is a hue bias, never a decision).
* **Danceability** — beat confidence dominates, with a tempo window on top:
  music you cannot find the beat of is not danceable however fast it is, and
  190 BPM and 60 BPM are both hard to dance to for opposite reasons.
* **Kickiness** — is the low end punching or sustaining? Read off the kick
  *role*, not the raw bass band, because the band contains the bass line too.
* **Genre** — MuQ-MuLan scored zero-shot against the sixteen subgenres, folded
  into one of four show styles. It answers what DSP cannot, because "electronic
  dance music" is a cultural category and not a spectral one.

  MuQ-MuLan is a joint music/text embedding, so the classes are whatever you
  ask it for: `GENRE_PROMPTS` names the sixteen subgenres directly, in a few
  phrasings each, and each subgenre takes its best-matching prompt. That is why
  it replaced PANNs Cnn14 here. Cnn14 is a general-audio tagger trained on
  AudioSet, so its 527 classes had to be *folded* into musical categories —
  guessing that `independent music` means rock, that `flamenco` means latin,
  that `christian music` fired on close vocal harmony does not mean gospel. The
  fold, not the model's confidence, is where its worst answers came from, and a
  model trained on music rather than on general audio does not need one.

  Similarities are cosine values rather than probabilities, so they go through
  a softmax at `GENRE_SOFTMAX_TEMPERATURE` before meeting the thresholds below.
  The temperature is set by where it puts the floor: an undecided model sits at
  1/16 = 0.06, and 0.15 lands almost exactly on a best prompt leading the field
  by a tenth of a cosine.

  The label only gets to set the style when it clears `GENRE_MIN_SCORE` *and*
  beats the runner-up by `GENRE_MIN_MARGIN`; otherwise the style comes from the
  signal and the label stays `unknown`. The thresholds exist because the four
  styles are not symmetric in what they cost: `calm` is the only one that turns
  the show off — no strobes, no drops, no accents — so a wrong `calm` costs the
  whole track while a wrong `dance` merely over-lights it. On real tracks a
  near-tie between two buckets three percent apart was enough to silence a
  song for three minutes.

  For the same reason there is a veto: a confident `calm` is overridden when
  arousal and danceability both say otherwise, because those are measured
  rather than inferred.

  Three tiers, and every one of them is optional. Without the MuQ-MuLan
  checkpoint the AudioSet fold answers instead, if `panns_inference` is
  installed; without either, the style comes from tempo and arousal and the
  label stays `unknown` — saying "this is house" from a tempo is how a live band
  gets lit like a DJ set. `perception.genre.source` records which tier answered,
  and it is not the same question as which model ran: a model that came back
  undecided loses to the signal and says so.

## Stage 8 — musical events (`events.py`)

The interface between the two halves. Every event carries the same five fields:

| Field | Meaning |
|---|---|
| `t` | seconds from the start of the track |
| `confidence` | 0–1, how sure the analyser is that this is real |
| `intensity` | 0–1, how big it is *musically* — not how bright to make it |
| `duration` | seconds; 0 for an instantaneous event |
| `effect` | the recommended gesture, as a hint the director may override |

| Type | When |
|---|---|
| `BEAT` | every tracked beat, with its position in the bar |
| `BAR` | every downbeat, with its position in the four-bar phrase |
| `DROP` | `kind` is `proper` (breakdown then sustained slam) or `hype` |
| `BUILDUP` | a span; `subdivision` is how far the roll actually doubles |
| `BREAK` | a span where the show should pull back |
| `SILENCE` | a span the show must go dark for |
| `ENERGY_SPIKE` | a crash, a stab, a riser landing |
| `BASS_HIT` | where the low end actually moves — in half-time music, emphatically not every beat |
| `VOCAL_SECTION` | a span where a voice is present |
| `MELODY_CHANGE` | bar-to-bar chroma rotation past a threshold |
| `TRANSITION` | a section boundary, naming the roles on both sides |
| `SECTION` | the same boundaries as a queryable timeline |

Ties at one instant resolve in a fixed order so a director processing the stream
in sequence sees context before content, with `DROP` last of all — it must win.

## The show engine (`src/show/`)

`musical-events.js` normalises the stream and, for a cached document from before
the event layer existed, **synthesises an equivalent one** from `beats`,
`downbeats`, `segments`, `drops` and `buildups`. Only the types an old document
can support are produced — there is no guessing at vocal spans from fields that
never carried them. A schema change costs the cache its nuance, not its
contents.

`director.js` turns events into intents under an explicit contrast model:

* **Accent budget** — a cap per rolling minute, from the show tier scaled by the
  intensity fader (dance 12, moderate 7, rock 4, calm 0) and by where the drive
  sits inside its tier. Candidates are considered **best first** rather than in
  time order: walking the track from the start spent the budget on whatever
  happened to come first, so a convincing accent ninety seconds in lost its
  place to three unconvincing ones in the opening verse.
* **Anticipation** — nothing in the two seconds before a drop except the
  build-up's own arc. A stray accent there spends the audience's attention a
  moment before the payoff needed it.
* **Recovery** — nothing for three seconds after a drop. The drop *is* the
  statement; carrying on flashing over it reads as the rig not having noticed.
* **Separation** — a burst must finish, plus a 60 ms gap, before the next one
  starts. At a 300 ms minimum length, a second burst 150 ms in clips most of the
  first before the fixtures have finished responding.
* **Section roles** decide where the show rests. Intros, breakdowns and outros
  carry no accents at all and are capped at quarter-note movement. That is what
  makes the chorus after them land.
* **Repeats look like repeats** — pattern and palette rotation are keyed on the
  passage's *identity*: the structure labeller's cluster where it has one, and
  MuQ's timbre embeddings where it does not, which recognises a returning chorus
  the labeller happened to split in two.

### What the measurements decide

Those rules did not change when the analysis did. What changed is what their
thresholds read. Every decision used to be a comparison against a percentile
level string (`low` / `mid` / `high`) or against `mood.arousal`, because that was
all a document carried. `src/show/score.js` is the reader for everything else it
now carries, and each question is asked of the thing that answers it:

| Decision | Read from |
| --- | --- |
| How hard the rig may work (`drive`) | The whole subgenre distribution, weighted by which classifier answered and how concentrated it was, floored by measured arousal and danceability |
| Which pattern a passage gets | The stem envelopes — is a voice or a kick carrying it — not how loud it is relative to the track |
| Whether the beat clock subdivides | `rhythm.intensityCurve` and tempo stability. Arousal says how excited a track is; pulse says whether there is a beat steady enough to subdivide |
| Stab or strobe | `bands.sub.attackMs` and its percussive share. A strobe spread over a kick is longer than the kick |
| How long an accent holds | `bands.bass.decayMs` — the music's own release |
| Whether the top of the vocabulary is affordable | Loudness crest. A brickwalled master has no headroom for a blinder to contrast against |
| Which drop variant | `breakdownScore` and `sustainScore`, not the drop's index. The deeper the hole it came out of, the bigger the arrival |
| How far a build-up's roll subdivides | `buildups[].subdivision`, which the analyser measured. Onset density is the fallback for older documents |
| Whether two passages are the same idea | MuQ timbre embeddings |
| Palette | The subgenre distribution and MuQ-MuLan's mood words, scored together with key and mood rather than one of them winning outright |

**Drive replaced the tier.** The four tiers survive as names for where a drive
landed, because a budget is easier to reason about in four rows than in a float.
Nothing inside the director reads the name. The reason is the failure the
distribution fixes: a near-tie between `ambient` and `funk` used to resolve by a
three-percent margin, and `ambient` meant the show was off for the whole track.
A weighted mean cannot do that — a track that cannot decide lands in the middle.

**The expression channel.** Twice a second the director emits an `EXPRESSION`
intent: level, bass, vocal, air, width, motion and decay, all 0..1. The engine
interpolates towards it at frame rate underneath whatever pattern is running, so
a chase through a breakdown and the same chase through the chorus after it are
the same pattern in the same colours and do not read as remotely the same thing.
It never touches the operator's master — a show that quietly rewrites the fader
is a show the operator cannot take back.

**The burst vocabulary** gained its quiet end for a reason the measurements made
obvious. Everything above `color-punch` is a flash, so a track with a soft or
unpercussive character had no accent it could use and therefore got none at all:
`calm` scored a budget of zero and that was the whole story. A stab marks a
transient without smearing it and a `glow` marks a moment on a ballad, so quiet
music can now be accented at all. The blinder and the white strobe stay reserved
for drops, which is what stops them meaning nothing by the second chorus.

**How many colours.** With the palette size set to `auto`, the director sizes it
per track: one colour per distinct passage, capped at four, reduced by one when
the music cannot carry the separation (a narrow, atonal mix has nowhere to put a
fourth hue). An explicit 2 / 3 / 4 from the operator always wins.

`render.js` translates intents into patches, clamps every value to what the
schema accepts, and debounces bursts. The clamping is not defensive
programming: the timeline fires from a timer callback, so an out-of-range value
is an uncaught exception that ends the process mid-set with the rig stuck on
whatever it was last told.

## Live mode (`realtime.py`)

Not a port of the offline pipeline — a different implementation of the same
interface, because live there is no future to look at.

**No models here.** Offline the beat grid comes from a transformer over the
whole file; live there is no whole file, and running one over a rolling window
costs more latency than a show can spend. So the live path keeps the signal
chain — autocorrelation over the last ten seconds of onset history, weighted by
the tempo prior — which is a much easier problem than deciding a record's tempo
from scratch: the window is short enough that the track is not changing over it,
and the one failure it still makes is the octave, which the folding below
covers.

* **Adaptive thresholds** — median plus a multiple of the median absolute
  deviation over a rolling ten-second window. MAD rather than standard
  deviation because the window contains the very peaks being detected, so a
  standard deviation is inflated by them and the detector goes deaf exactly
  when the music gets busy.
* **A phase-locked loop** rather than a tracker: an oscillator runs at the
  current tempo and is nudged by onsets arriving near where it expected one.
  Proportional term for phase, a much smaller integral term for frequency —
  without the second one the loop re-earns the same 100 ms of drift every bar.
  Only onsets within a third of a beat count: anything further is a syncopation,
  and following it walks the grid onto the off-beat.
* **Octave folding** — when the kick drops out for a breakdown the estimator
  legitimately reports half tempo, and averaging 174 with 87 gives 130, a tempo
  the track has never played. A reading that folds to within 10 % of the running
  tempo is folded; one that does not is a real tempo change and is followed.
* **Drops are called on the rise**, with lower confidence and an `unconfirmed`
  flag, because waiting four seconds for the sustain is correct offline and
  useless live.

Latency is one hop (23 ms at the defaults) plus the caller's own buffering.
Throughput is roughly fifty times real time on one core.

---

## Tuning

Every constant lives in `src/analysis/config.py`, with its unit and its reason.
Pass a modified `AnalysisConfig` into `pipeline.analyze()`, or edit the
defaults. The ones most worth reaching for:

| Parameter | Default | Turn it when |
|---|---|---|
| `preprocess.target_lufs` | -18.0 | never, unless every threshold is being retuned with it |
| `preprocess.noise_reduction` | 0.5 | source material is consistently noisy (0 disables) |
| `rhythm.tempo_min` / `tempo_max` | 55 / 200 | the room's music genuinely lives outside that |
| `rhythm.tempo_prior_bpm` | 120.0 | a genre with a consistently different tactus (drum & bass, dub) |
| `rhythm.beat_tightness` | 100.0 | live or rubato material — lower follows, higher holds |
| `rhythm.plp_stability_threshold` | 0.60 | tracks with real tempo drift are being tracked rigidly |
| `structure.min_section_sec` | 8.0 | scene changes feel too frequent (raise) or too sparse (lower) |
| `structure.max_clusters` | 10 | long-form sets need more sections |
| `dynamics.drop_min_rise` | 0.22 | drops are missed (lower) or invented (raise) |
| `dynamics.drop_density_sec` | 50.0 | roughly one drop per this many seconds is kept |
| `dynamics.buildup_max_sec` | 16.0 | build-ups run longer or shorter in the genre |
| `events.beat_min_confidence` | 0.10 | the show is accenting beats it should not trust |

Two more live in `perception.py` rather than the config, because they are about
trusting the tagger rather than about the signal: `GENRE_MIN_SCORE` (0.15) and
`GENRE_MIN_MARGIN` (1.5).

Show-side pacing is in `src/show/director.js`: `ACCENT_BUDGET`, `RECOVERY_SEC`,
`ANTICIPATION_SEC`, `MIN_BURST_MS`, `EXPRESSION_STEP_SEC`, and the `ROLE_PROFILE`
table that decides what each section role is allowed to do.

Palette banks, the per-subgenre drive / palette / pattern tables and the burst
choice are in `src/show/look.js`. `SUBGENRE_DRIVE` is the one to reach for first:
it is the table that decides how hard each kind of music makes the rig work, and
every other show-side threshold is downstream of it.

`src/show/score.js` reads the continuous half of the document — stem envelopes,
band character, loudness, timbre embeddings, the subgenre distribution — and
`SEMANTIC_FULL_SPREAD` is its one calibration: how wide a spread across the mood
vocabulary counts as the track having said something definite.

## Extension points

**A new feature.** Add it to `FrameFeatures` in `features.py` and compute it in
`extract()`. Everything downstream reads the object, so it is available
everywhere immediately.

**A new event type.** Add the constant and a generator to `events.py`, list it
in `TYPES` and in the priority order in `generate()`, then mirror the constant
in `src/show/musical-events.js`. The director ignores types it does not handle,
so an unhandled new type is inert rather than fatal.

**A new lighting gesture.** Add an intent kind in `src/show/intents.js`, emit it
from a director pass, and handle it in `render.js`. Unknown kinds are skipped by
the renderer.

**A different show style.** `ROLE_PROFILE` and `ACCENT_BUDGET` in `director.js`
are the two tables that define how a show paces itself, and `SUBGENRE_DRIVE` in
`look.js` is what decides how much of that budget a given track earns. Changing
`ROLE_PROFILE.breakdown.accents` to `true` is a one-line way to see how much of
the show's character comes from where it rests.

**A new burst.** Add it to `BURST` in `src/show/intents.js`, give it a case in
`resolveEnergyOverride` in `src/server/engine.js`, list it in `ENERGY_EFFECTS`
in `presets.js` and place it in `BURST_PRIORITY` in `render.js` — that order is
which gesture wins when two collide. Then return it from `look.burstFor()` under
the measurement that should reach for it.

**A different segmentation.** `structure.analyse()` returns a list of
`Section`; anything that produces that list will work. `energy_sections()` is
the built-in fallback and shows the minimum contract.

**Another classifier.** Two seams, depending on which half you want to move.
`model_adapters.mulan_scores()` returns `{vocabulary: [{label, score}]}` for
any set of text prompts, and anything returning that shape for the `genre`
vocabulary can replace MuQ-MuLan. Further down, `tagger.tag()` returns
`{label: probability}` over AudioSet's vocabulary; its consumers are
`perception.classify_genre`, as the genre fallback, and `bands.infer_roles`,
which uses the instrument classes as role priors and does not care about
genre at all.

## Debugging

```bash
python src/analyze.py track.wav --report report.html
```

produces a standalone page — no plotting dependency, no network — showing the
waveform with sections behind it, beat markers scaled by confidence, all seven
bands, the impact curve with drops and build-ups over it, and every musical
event on a lane per type. Hovering gives the section, the events near the
cursor, and their confidences.

`analysis-cache` entries are plain JSON; `python -m json.tool` on one is often
faster than re-running anything.

The analyser logs to stderr with a `[stage]` prefix and never to stdout —
stdout is the protocol.

## Performance

Measured on a three-minute track, three CPU threads, no GPU:

| | Wall clock | Relative to realtime |
|---|---|---|
| full pipeline | 107 s | 0.59× |
| `separate_sources=False` | 24 s | 0.13× |

Separation is three quarters of the cost on its own:

| Stage | Seconds |
|---|---|
| separation (Demucs) | 76 |
| preprocess (HPSS dominates) | 16 |
| rhythm (beat model included) | 7 |
| features | 2 |
| bands, structure, dynamics, perception | 3 |

**Device.** `models.device()` decides once per process: CUDA when it is there,
otherwise threads, leaving one core free so an analysis cannot starve the
Art-Net render loop. `ARTNET_ANALYSIS_DEVICE=cpu` forces threads — worth setting
on a one-machine rig whose GPU is busy driving a visualiser, where competing for
it costs more than it buys. A GPU turns the separation row from a minute into a
few seconds, which is most of why the numbers above are the pessimistic case.

**Separation runs in its own thread** alongside preprocessing and features. On a
GPU that genuinely overlaps. On CPU it buys almost nothing, because Demucs is
already using every core the process has — the numbers above are what that looks
like, and they are the argument for `separate_sources=False` on a machine
analysing a queue during a set rather than a library overnight. The tagger, when
installed, starts even earlier: it reads the file directly and needs nothing from
the rest. Structure and perception run side by side.

**Weights are cached, and the cache is checked before the network.** Loading a
checkpoint by short name sends the resolver to the network even when the file is
already on disk, and a hung request there is a show that does not start — which
is not hypothetical, it hung repeatedly while this was being built. Warm the
cache before leaving for the venue:

```bash
python -c "from analysis import models; models.warm_up()"
```

The worker keeps librosa's imports, numba's JIT caches and both models resident
between tracks, so only the first analysis of a server's lifetime pays the cold
start; `src/analyzer-worker.js` prewarms it during startup so even that lands
while the operator is still opening the UI.

Curves are decimated to one point every half second before they enter the
document. Undecimated, eleven curves on a four-minute track is tens of megabytes
of JSON travelling to a browser that draws it 900 pixels wide.

## Testing

`tests/python/synth.py` builds tracks whose kick times, metre and arrangement
are known by construction — real music cannot be checked into a repository and
has no ground truth to assert against. The signals are crude on purpose: a test
that only passes on a convincing synthetic mix is a test of the mix.

```bash
python -m unittest discover -s tests/python     # analysis
npm test                                        # show engine and server
```

Synthetic signals prove the DSP is correct; they cannot prove the *judgement*
on top of it is sensible, because a synthetic track has no genre, its sections
are identical loops, and its arrangement is whatever the generator wrote. So
`tests/fixtures/tracks/` holds the show-facing parts of real analyses — sections,
drops, mood, subgenre scores, with the frame-level curves stripped — and
`test_real_tracks.py` pins the decisions made on top of them. Both defects those
five tracks exposed were in that layer, not in the signal processing.

To add one: analyse a track, then keep the fields that file's generator keeps.
Around 6 KB each, small enough to read in a diff.

### MuQ and MuQ-MuLan runtime

Install dependencies with `project_venv/bin/python -m pip install -r requirements.txt`.
The Transformers version is pinned because MuQ calls the Conformer encoder's
v4 hidden-state API directly; Transformers 5 is incompatible with this path.
Run `project_venv/bin/python scripts/download-models.py` before playback to
provision MuQ, MuQ-MuLan, and its XLM-RoBERTa text encoder/tokenizer.

The adapters reuse models between tracks and follow `ARTNET_ANALYSIS_DEVICE`
(or automatic CUDA selection). They read `ARTNET_MODEL_DIR`; individual local
checkpoint paths can be set with `ARTNET_MUQ_MODEL`, `ARTNET_MUQ_MULAN_MODEL`,
and `ARTNET_MUQ_TEXT_MODEL` (retain `xlm-roberta` in the text directory name,
as the upstream loader uses it to select the architecture).
MuQ-MuLan supports the published `pytorch_model.bin` checkpoint as well as
safetensors. Its text encoder must be provisioned locally before analysis.

The analysis document exposes `embeddings` and `semantic_scores` with separate
`meta.modelUsage.muq` and `meta.modelUsage.muqMulan` flags. A failure in either
optional pass leaves the other result intact. These outputs feed the show director: semantic similarities choose the palette
and temper movement/accents, while embeddings detect recurring passages and
texture changes.


### Show score and expressive rendering

Rich analysis documents use `src/show/score.js`; older cached documents keep the
legacy director. The score uses these musical signals:

| Analysis | Lighting decision |
| --- | --- |
| MuQ-MuLan similarities | Relative warm/cold, intimate, spacious and aggressive preferences for the track palette, movement and accent style; ambiguous similarities keep the key/mood palette |
| MuQ embeddings | Repeated passage identities and restrained color changes at timbral changes |
| Stem curves, scores and source shares | Bass/kick edge lighting, vocal centre lighting and snare/hat/synth texture; source confidence attenuates leakage |
| Band curves, importance and rhythmicity | Activity and groove when stems are unavailable |
| Band decay and percussion | Smooth envelope release and accent duration |
| Energy, impact and loudness range | Scene brightness and dynamic contrast, below the operator master |
| SNR and beat confidence | Discount uncertain accent candidates |
| Stereo width/correlation | Spatial spread across the fixtures |
| Spectral centroid, rolloff, flatness and zero-crossing rate | Air and texture |
| Sections, vocal spans, silences, breaks, builds, drops and spikes | Rest, anticipation, recovery and budgeted accent timing |
| Tempo/stability, key, mode, mood and genre | Tempo following and fallback look choices |

`Ensemble` layers stem activity over centre/edge fixture groups. `Ribbon`
continuously blends the chosen palette across the rig. Both render at DMX frame
rate, with half-second analysis targets smoothed between updates. `Colour Punch`
is a solid, non-strobing accent; strobes and white blinders require stronger
musical evidence and share the accent budget.

The intensity slider adjusts musical brightness, motion and accent allowance.
It never changes the master dimmer. Silence closes automatic lighting at its
exact boundary; stopping clears expressive controls. Seeking reconstructs the
current scene and expression without firing missed bursts. Diagnostic fields
such as model names, sample rate, file hashes and normalization gain are not
converted into lighting effects.
