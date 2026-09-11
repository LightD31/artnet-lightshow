'use strict';

// The look vocabulary decides what a track looks like before any timeline
// exists, so these tests are about that judgement on its own: how much of the
// rig a track earns, which colours it gets, how many of them, and which of the
// five bursts a moment deserves.

const test = require('node:test');
const assert = require('node:assert/strict');

const look = require('../../src/show/look');
const { makeScore } = require('../../src/show/score');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');

const AVAILABLE = new Set(PATTERNS.map((p) => p.id));
const LOUD = { valence: 0.6, arousal: 0.88, danceability: 0.85, kickiness: 0.8 };
const QUIET = { valence: 0.5, arousal: 0.18, danceability: 0.2, kickiness: 0.1 };

/** A genre block shaped the way the analyser now writes one. */
function genre(subScores, over = {}) {
  const ranked = Object.entries(subScores).sort((a, b) => b[1] - a[1]);
  return {
    label: ranked[0][0], confidence: ranked[0][1], style: 'dance',
    source: 'muq-mulan', subScores, ...over,
  };
}

const driveOf = (analysis, mood) => look.driveFor(analysis, mood, makeScore(analysis));

// ── How hard the rig works ──────────────────────────────────────────────────

test('a near-tie lands between its two subgenres instead of picking one', () => {
  // The failure the distribution exists to fix: `ambient` beating `funk` by
  // three percent used to mean the whole track was lit as a ballad, because the
  // winner's tier was the only thing anyone read.
  const tie = { ambient: 0.29, funk: 0.27, jazz: 0.06, pop: 0.05 };
  const mood = { valence: 0.5, arousal: 0.55, danceability: 0.5, kickiness: 0.4 };
  const { drive } = driveOf({ genre: genre(tie) }, mood);

  const onlyAmbient = driveOf({ genre: genre({ ambient: 0.9, funk: 0.02 }) }, mood).drive;
  const onlyFunk = driveOf({ genre: genre({ funk: 0.9, ambient: 0.02 }) }, mood).drive;
  assert.ok(drive > onlyAmbient, 'a tie must not be lit as the quieter of the two');
  assert.ok(drive < onlyFunk, 'nor as the louder one');
});

test('a confident quiet label still cannot silence a measurably loud track', () => {
  // A classifier calling a track `jazz` does not make its measured arousal
  // untrue, and lighting a loud track like a ballad is the most visible failure
  // this engine has.
  const { drive } = driveOf({ genre: genre({ jazz: 0.95, folk: 0.02 }) }, LOUD);
  assert.ok(drive >= 0.4, `a loud track fell to ${drive}`);
});

test('a quiet track with a quiet label stays quiet', () => {
  const { tier } = driveOf({ genre: genre({ ambient: 0.9, folk: 0.05 }) }, QUIET);
  assert.equal(tier, 'calm');
});

test('a document with a style but no distribution is still believed', () => {
  // Older documents carry the label without its shape. Dismissing them is how a
  // cached analysis lost its style entirely and got lit from its tempo.
  const declared = driveOf({ genre: { label: 'ambient', style: 'calm', confidence: 0.9 } }, QUIET);
  const nothing = driveOf({}, QUIET);
  assert.ok(declared.drive < nothing.drive, 'the declared style should pull it down');
});

test('the tier is only a name for where the drive landed', () => {
  assert.equal(look.tierOf(0.95), 'dance');
  assert.equal(look.tierOf(0.6), 'moderate');
  assert.equal(look.tierOf(0.4), 'rock');
  assert.equal(look.tierOf(0.1), 'calm');
});

// ── Palette ─────────────────────────────────────────────────────────────────

const palette = (over = {}) => look.buildPalette({
  key: 'C', scale: 'major', mood: LOUD, paletteSize: 4,
  colorPresets: COLOR_PRESETS, ...over,
});

test('the mood words decide when nothing has classified the track', () => {
  const warm = palette({ score: makeScore({ semantic_scores:
    [{ label: 'warm', score: 0.5 }, { label: 'organic', score: 0.45 }, { label: 'cold', score: 0.1 }] }) });
  assert.equal(warm.name, 'desert');
});

test('a confident subgenre outweighs a marginal pair of mood words', () => {
  const score = makeScore({
    genre: genre({ dubstep: 0.85, edm: 0.08 }),
    semantic_scores: [{ label: 'warm', score: 0.31 }, { label: 'organic', score: 0.3 },
      { label: 'cold', score: 0.28 }],
  });
  assert.equal(palette({ score }).name, 'volcanic');
});

test('every palette stays inside the colour table the rig actually has', () => {
  const short = COLOR_PRESETS.slice(0, 4);
  for (const size of [2, 3, 4]) {
    const { palette: colours } = palette({ paletteSize: size, colorPresets: short });
    assert.ok(colours.every((i) => i >= 0 && i < short.length), `size ${size}: ${colours}`);
  }
});

test('a renamed or missing bank falls back rather than taking the show down', () => {
  const score = makeScore({ genre: genre({ edm: 0.9 }) });
  const { palette: colours, name } = palette({ score, paletteSize: 2 });
  assert.ok(name && colours.length === 2);
});

// ── How many colours ────────────────────────────────────────────────────────

test('the palette holds one colour per distinct passage, capped at four', () => {
  const rich = makeScore({ keyStrength: 0.9, stereo: { width: 0.8, correlation: 0 } });
  assert.equal(look.paletteSizeFor({ score: rich, identities: 2, mood: LOUD }), 2);
  assert.equal(look.paletteSizeFor({ score: rich, identities: 3, mood: LOUD }), 3);
  assert.equal(look.paletteSizeFor({ score: rich, identities: 6, mood: LOUD }), 4);
});

test('music that cannot carry the separation gets one colour fewer', () => {
  // A narrow, atonal mix has nowhere to put a fourth hue: the colours stop
  // reading as meaning anything and start reading as arbitrary.
  const flat = makeScore({ keyStrength: 0.05, stereo: { width: 0.05, correlation: 0.95 } });
  const rich = makeScore({ keyStrength: 0.9, stereo: { width: 0.9, correlation: 0 } });
  const mood = { valence: 0.2, arousal: 0.6 };
  assert.ok(look.paletteSizeFor({ score: flat, identities: 4, mood })
    < look.paletteSizeFor({ score: rich, identities: 4, mood }));
});

test('the count never leaves the range the palette banks actually have', () => {
  for (const identities of [0, 1, 2, 9, 40]) {
    const size = look.paletteSizeFor({ identities, mood: LOUD });
    assert.ok([2, 3, 4].includes(size), `${identities} identities gave ${size}`);
  }
});

// ── Which burst ─────────────────────────────────────────────────────────────

const burst = (over) => look.burstFor({
  character: { energy: 0.8, texture: 0.6, hats: 0.6 }, drive: 0.9,
  score: makeScore({}), ...over,
});

test('the two loudest gestures belong to drops and nowhere else', () => {
  const loud = new Set(['blinder', 'white-strobe']);
  assert.ok(loud.has(burst({ moment: 'drop' })));
  for (const drive of [0.4, 0.6, 0.8, 1]) {
    for (const articulation of [0, 0.5, 1]) {
      const score = makeScore({ bands: { sub: { percussive: articulation, attackMs: 90 } } });
      const chosen = burst({ moment: 'accent', drive, score });
      assert.ok(!loud.has(chosen), `an accent reached ${chosen}`);
    }
  }
});

test('a percussive low end is marked by a hole, not strobed', () => {
  // A strobe spread over a kick is longer than the kick, so it smears the very
  // transient the accent was marking. Taking the light away for exactly as long
  // as the hit does not, and cannot be read as the pattern stuttering.
  const punchy = makeScore({ bands: { sub: { percussive: 0.9, attackMs: 25 } } });
  const sustained = makeScore({ bands: { sub: { percussive: 0.1, attackMs: 190 } } });
  assert.equal(burst({ moment: 'accent', score: punchy }), 'kill');
  assert.equal(burst({ moment: 'accent', score: sustained }), 'color-strobe');
});

test('quiet music gets the soft accent rather than no accent at all', () => {
  assert.equal(burst({ moment: 'accent', drive: 0.2, character: { energy: 0.2 } }), 'glow');
});

test('nothing strobes across a voice', () => {
  for (const drive of [0.4, 0.7, 0.9, 1]) {
    const chosen = burst({ moment: 'accent', drive, vocal: true });
    assert.ok(['glow', 'kill'].includes(chosen), `sang over with ${chosen}`);
  }
});

test('a compressed master is not given a gesture it has no headroom for', () => {
  // A strobe over a wall of sound has nothing to contrast against. Taking the
  // light away always does, so that is what a brickwalled master gets.
  const squashed = makeScore({ loudness: { truePeakDb: -0.2, integratedLufs: -5 },
    bands: { sub: { percussive: 0.1, attackMs: 190 } } });
  assert.equal(burst({ moment: 'accent', headroom: squashed.crest >= 0.35, score: squashed }),
    'kill');
});

// ── Which pattern ───────────────────────────────────────────────────────────

const pick = (character, over = {}) => look.pickPattern({
  character, available: AVAILABLE, score: makeScore({}), seed: 0, drive: 0.8, dance: 0.5, ...over,
});

test('a quiet passage carried by a voice holds the centre instead of chasing', () => {
  const chosen = pick({ vocal: 0.8, kick: 0.2, bassline: 0.2, energy: 0.3, pulse: 0.5 },
    { drive: 0.4 });
  assert.ok(['ensemble', 'ribbon', 'wave', 'fade', 'twinkle', 'solid'].includes(chosen), chosen);
});

test('a voice over a driving passage still gets movement', () => {
  // "Vocal-led" is not the same as "quiet". A sung chorus over a four-to-the-
  // floor kick trips the same test a ballad does, and washing it out is how
  // most of a party track ended up static on a rig with no moving heads.
  const chosen = pick({ vocal: 0.8, kick: 0.2, bassline: 0.2, energy: 0.6, pulse: 0.5 });
  assert.ok(!['solid', 'fade', 'ribbon', 'twinkle'].includes(chosen),
    `a driving chorus got ${chosen}`);
});

test('a passage carried by a kick with a pulse locks to it', () => {
  const chosen = pick({ vocal: 0.1, kick: 0.8, bassline: 0.7, energy: 0.8, pulse: 0.8 },
    { dance: 0.8 });
  assert.ok(!['solid', 'fade', 'ribbon'].includes(chosen), `a groove got ${chosen}`);
});

test('the same measurements always give the same pattern', () => {
  // Repeats have to look like repeats, and that starts here.
  const character = { vocal: 0.1, kick: 0.7, bassline: 0.6, energy: 0.7, pulse: 0.7 };
  assert.equal(pick(character), pick(character));
});

test('a pattern is always one the rig actually has', () => {
  const tiny = new Set(['solid', 'chase']);
  for (const energy of [0.1, 0.5, 0.9]) {
    const chosen = look.pickPattern({
      character: { energy, kick: energy, pulse: energy }, available: tiny,
      score: makeScore({}), seed: 3, drive: energy,
    });
    assert.ok(tiny.has(chosen), `picked ${chosen} on a two-pattern rig`);
  }
});
