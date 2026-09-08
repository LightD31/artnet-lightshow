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

**Instrument roles** — kick, bassline, snare, hats, vocal, synth — come from
combining the harmonic/percussive split with band ranges, plus a movement
weighting for vocals (a held pad must not read as a singer) and a chroma-change
weighting for synths. AudioSet tags, when available, adjust the *scores* but
never the curves: a missing or wrong tag costs the show nuance, not timing.

## Stage 4 — rhythm (`rhythm.py`)

```
onset envelope → tempo → beat grid → metre → downbeats
```

**Tempo.** Autocorrelation of the onset envelope, weighted by a log-normal prior
centred on 120 BPM (perceived tempo clusters there on a log scale), reinforced
by each candidate's own harmonics, then — and this is the part that matters —
the top ten candidates are **re-ranked by pulse-train fit**.

Autocorrelation asks "does the signal look like itself a beat later", which a
hi-hat pattern answers yes to at every subdivision. A pulse train asks a better
question: *if I put a light on every one of these instants, how much of the
music do I hit, and how much of what I hit is loud?* Two terms, multiplied:

* **precision** — mean envelope at the pulses over the overall mean. High when
  the pulses land on transients, but half tempo scores just as well since it
  lands on every other kick.
* **recall** — the share of the envelope's energy near a pulse. This is what
  half tempo cannot fake: it misses half the beats.

Scored over short windows and averaged rather than over the whole track, because
a candidate lag is only accurate to a fraction of a frame and over three minutes
that error accumulates into hundreds of milliseconds of walk-off — which would
score the *correct* tempo worse than a wrong one that happens to be closer to a
whole number of frames.

A final check catches the remaining failure: if every other pulse is markedly
weaker than the one before it — measured on a **low-band** onset envelope, where
a hi-hat does not appear — the grid is counting the subdivision rather than the
beat, and the tempo is halved. Guarded by the prior as well, so it can only pull
a fast reading back towards tapping speed, never turn 128 BPM into 64.

**Beats.** Dynamic-programming tracking seeded with that tempo, with a
predominant-local-pulse tracker taking over when the tempo curve says the track
genuinely drifts (stability below 0.60). Then two refinements:

* **Phase** — beats are snapped to a high-resolution onset envelope (512-point
  window, 128-sample hop). Tempo tracking wants a long window; phase wants the
  opposite, and a 2048-point window at 22 kHz reports onsets about 25 ms late,
  every time. The fine grid puts them within ~5 ms.
* **Period** — a least-squares fit through the whole grid. Beat times land on
  frames, so the interval between two of them is quantised to ~23 ms, which at
  140 BPM is 3.5 BPM of error in the median interval alone. The rounding pattern
  across a hundred beats carries the fraction the individual intervals throw
  away.

**Confidence** is per beat, not per track: onset strength blended with how
regular the beat's spacing is. A strong hit off the grid is a fill; a weak beat
exactly where the grid predicted is still a beat and the show can keep counting
through it. A show that knows which beats it is sure of can accent those and let
the rest pass, which is what a human operator does when the mix gets muddy.

**Downbeats** come from scoring every (metre, phase) hypothesis against three
pieces of evidence — low-end energy, spectral novelty, and harmonic change —
because none is reliable alone. Beat one is often *not* the loudest beat; in
most dance music the loudest beat is wherever the snare is. Harmonic change is
the cue that survives a bar with no kick. 4/4 gets a small bias because it is
overwhelmingly more common and a 3/4 hypothesis fits a 4/4 track's every-third
pattern often enough to win a close contest on noise.

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

1. a section containing a detected drop is a `drop` — it overrides everything;
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
rather than as variety.

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
* **Genre** — the pipeline's only learned component: PANNs Cnn14 over AudioSet's
  527 classes, folded into sixteen subgenres and then into one of four show
  styles. It answers what DSP cannot, because "electronic dance music" is a
  cultural category and not a spectral one.

  Entirely optional. Without torch installed, the style comes from tempo and
  arousal instead, and the genre label stays `unknown` — saying "this is house"
  from a tempo is how a live band gets lit like a DJ set.

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
  intensity fader (dance 12, moderate 7, rock 4, calm 0). Over budget, the
  lowest-priority candidates go.
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
  section's cluster label.

`render.js` translates intents into patches, clamps every value to what the
schema accepts, and debounces bursts. The clamping is not defensive
programming: the timeline fires from a timer callback, so an out-of-range value
is an uncaught exception that ends the process mid-set with the rig stuck on
whatever it was last told.

## Live mode (`realtime.py`)

Not a port of the offline pipeline — a different implementation of the same
interface, because live there is no future to look at.

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

Show-side pacing is in `src/show/director.js`: `ACCENT_BUDGET`, `RECOVERY_SEC`,
`ANTICIPATION_SEC`, `MIN_BURST_MS`, and the `ROLE_PROFILE` table that decides
what each section role is allowed to do.

Palette banks, genre-to-style mapping and the pattern pools are in
`src/show/look.js`.

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

**A different show style.** `ROLE_PROFILE` and `ACCENT_BUDGET` in
`director.js` are the two tables that define how a show paces itself. Changing
`ROLE_PROFILE.breakdown.accents` to `true` is a one-line way to see how much of
the show's character comes from where it rests.

**A different segmentation.** `structure.analyse()` returns a list of
`Section`; anything that produces that list will work. `energy_sections()` is
the built-in fallback and shows the minimum contract.

**Another classifier.** `tagger.tag()` returns `{label: probability}` over
AudioSet's vocabulary. Anything returning that shape can replace it; the
consumers are `perception.classify_genre` and `bands.infer_roles`.

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

On a four-minute track, one core of a recent laptop:

| Stage | Roughly |
|---|---|
| preprocess (HPSS dominates) | 40 % |
| features | 15 % |
| rhythm | 15 % |
| structure | 20 % |
| everything else | 10 % |

The tagger, when installed, runs concurrently with all of it from the first
instant — it reads the file directly and needs nothing from the rest — so it is
effectively free. Structure and perception run side by side. The worker keeps
librosa's imports, numba's JIT caches and the PyTorch model resident between
tracks, so only the first analysis of a server's lifetime pays the cold start;
`src/analyzer-worker.js` prewarms it during startup so even that lands while the
operator is still opening the UI.

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
