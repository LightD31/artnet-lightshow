// A CDJ track's own file is analysed, and then rekordbox's grid and phrases
// for that file stand in for the analyser's beats and sections: the show then
// steps on the beats the deck counts, and changes look where the DJ's
// rekordbox says the chorus starts.

import test from 'node:test';
import assert from 'node:assert';

import { applyRekordbox } from '../../src/rekordbox-analysis.ts';
import { ShowDirector } from '../../src/show/director.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

const BPM = 128;
const BEAT = 60 / BPM;
const BARS = 120;

/** A four-minute dance track as the analyser heard it: its beats a touch early. */
function analysis() {
  const beats = Array.from({ length: BARS * 4 }, (_, i) => +(i * BEAT).toFixed(3));
  const at = (bar) => +(bar * 4 * BEAT).toFixed(3);
  return {
    duration: BARS * 4 * BEAT + 2,
    bpm: 127.9,
    meter: 4,
    beats,
    beatStrengths: beats.map((_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats: beats.filter((_, i) => i % 4 === 0),
    downbeatConfidence: 0.4,
    beatSource: 'beat_this',
    tempoStability: 0.95,
    mood: { valence: 0.6, arousal: 0.85, danceability: 0.85 },
    genre: { label: 'edm', confidence: 0.9, style: 'dance' },
    segments: [
      { start: 0, end: at(30), role: 'verse', level: 'low', energy: 0.2, brightness: 0.3, label: 'A' },
      { start: at(30), end: at(60), role: 'verse', level: 'high', energy: 0.8, brightness: 0.7, label: 'B' },
      { start: at(60), end: at(120) + 2, role: 'verse', level: 'mid', energy: 0.5, brightness: 0.5, label: 'C' },
    ],
    drops: [],
    buildups: [],
  };
}

// rekordbox's grid for the same file: 12 ms later than the analyser's beats,
// and bar lines starting on its second beat — the DJ moved the downbeat.
const OFFSET_MS = 12;
const grid = Array.from({ length: BARS * 4 }, (_, i) => ({
  offset: OFFSET_MS + i * BEAT * 1000, count: ((i + 3) % 4) + 1, bpm: 128,
}));

// A club track's phrases: Intro, Up, Chorus, Down, Up, Chorus, Outro, by bar
// — rekordbox's bars, which start on its second beat.
const phrase = (bar, kind) => ({ index: 0, beat: bar * 4 + 2, kind, phraseType: '' });
const club = {
  mood: 'high', bank: 'default', endBeat: 104 * 4 + 1 + 64,
  phrases: [phrase(0, 1), phrase(8, 2), phrase(24, 5), phrase(40, 3), phrase(52, 2), phrase(56, 5), phrase(104, 6)],
};

test('rekordbox\'s grid becomes the beat grid', () => {
  const out = applyRekordbox(analysis(), { beatGrid: grid });
  assert.strictEqual(out.beatSource, 'rekordbox');
  assert.strictEqual(out.beats.length, BARS * 4);
  assert.strictEqual(out.beats[10], Math.round(OFFSET_MS + 10 * BEAT * 1000) / 1000);
  assert.deepStrictEqual(out.downbeats.slice(0, 2), [out.beats[1], out.beats[5]], 'the bars the DJ set');
  assert.deepStrictEqual([out.bpm, out.meter, out.downbeatConfidence], [128, 4, 0.9]);
  assert.deepStrictEqual(out.beatStrengths.slice(0, 5), [0.9, 0.4, 0.4, 0.4, 0.9], 'each beat keeps the strength heard nearest it');
  assert.deepStrictEqual(out.segments, analysis().segments);
  assert.strictEqual(out.sectionSource, undefined, 'no phrases, the analyser\'s sections');

  const input = analysis();
  assert.strictEqual(applyRekordbox(input, { beatGrid: grid.slice(0, 8) }).beats, input.beats, 'a grid rekordbox never finished is ignored');
  const backwards = grid.map((b, i) => (i === 40 ? { ...b, offset: 0 } : b));
  assert.strictEqual(applyRekordbox(input, { beatGrid: backwards }).beatSource, 'beat_this');
  assert.strictEqual(applyRekordbox(input, { songStructure: club }).segments, input.segments,
    'phrases are counted in rekordbox\'s beats: without its grid they cannot be placed');
});

test('rekordbox\'s phrases become the sections, with roles by mood', () => {
  const out = applyRekordbox(analysis(), { beatGrid: grid, songStructure: club });
  assert.deepStrictEqual([out.sectionSource, out.phraseMood], ['rekordbox', 'high']);
  const s = out.segments;
  assert.deepStrictEqual(s.map((x) => x.role), ['intro', 'verse', 'drop', 'breakdown', 'verse', 'drop', 'outro']);
  assert.deepStrictEqual(s.map((x) => x.label), ['rekordbox:Intro', 'rekordbox:Up', 'rekordbox:Chorus', 'rekordbox:Down',
    'rekordbox:Up', 'rekordbox:Chorus', 'rekordbox:Outro'], 'a second Chorus is a return of the first');
  assert.strictEqual(s[0].start, 0, 'from the top of the file');
  assert.strictEqual(s[2].start, out.beats[24 * 4 + 1], 'on rekordbox\'s bar line');
  assert.ok(out.downbeats.includes(s[2].start));
  assert.strictEqual(s[s.length - 1].end, analysis().duration, 'to the end of it');
  for (let i = 1; i < s.length; i++) assert.strictEqual(s[i].start, s[i - 1].end, 'no gaps');

  // Measured from the analysed sections they overlap.
  assert.deepStrictEqual([s[0].level, s[0].energy], ['low', 0.2]);
  assert.strictEqual(s[3].level, 'high', 'bars 40–52 sit in the analyser\'s loud section');
  const straddling = s[2];                  // bars 24¼–40¼: 5¾ bars at 0.2, 10¼ at 0.8
  assert.ok(Math.abs(straddling.energy - (5.75 * 0.2 + 10.25 * 0.8) / 16) < 0.005, `energy ${straddling.energy}`);

  const song = applyRekordbox(analysis(), {
    beatGrid: grid,
    songStructure: { mood: 'mid', endBeat: 400, phrases: [phrase(0, 1), phrase(8, 2), phrase(24, 9), phrase(40, 3), phrase(56, 8), phrase(64, 9), phrase(96, 10)] },
  });
  assert.deepStrictEqual(song.segments.map((x) => x.role), ['intro', 'verse', 'chorus', 'verse', 'bridge', 'chorus', 'outro']);
  assert.deepStrictEqual(song.segments.map((x) => x.label.slice(10)), ['Intro', 'Verse 1', 'Chorus', 'Verse 2', 'Bridge', 'Chorus', 'Outro']);

  const quiet = applyRekordbox(analysis(), {
    beatGrid: grid, songStructure: { mood: 'low', endBeat: 400, phrases: [phrase(0, 3), phrase(16, 6), phrase(32, 42)] },
  });
  assert.deepStrictEqual(quiet.segments.map((x) => [x.role, x.label]),
    [['verse', 'rekordbox:Verse 1'], ['verse', 'rekordbox:Verse 2'], ['unknown', 'rekordbox:Phrase 42']]);
});

test('the director plans a show on rekordbox\'s sections', () => {
  const out = applyRekordbox(analysis(), { beatGrid: grid, songStructure: club });
  const director = new ShowDirector({ patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 50 });
  const { intents } = director.plan(out);
  const sections = intents.filter((i) => typeof i.source === 'string' && i.source.startsWith('section:'));
  assert.deepStrictEqual(sections.map((i) => i.source),
    ['section:intro', 'section:verse', 'section:drop', 'section:breakdown', 'section:verse', 'section:drop', 'section:outro']);
  // Each scene starts on rekordbox's bar line for its phrase (within the
  // director's snap to a downbeat).
  const drop = sections[2];
  assert.ok(Math.abs(drop.timeMs / 1000 - out.segments[2].start) < 0.05,
    `the chorus look at ${drop.timeMs} ms, the phrase at ${out.segments[2].start} s`);
});
