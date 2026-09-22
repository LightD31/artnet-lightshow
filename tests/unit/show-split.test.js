'use strict';

// Split looks: in a driving passage on a travelling pattern, one fixture group
// holds a wash in colour B while the rest carry the pattern. The director asks
// for the split; the engine decides which group from the rig it has.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ShowDirector } = require('../../src/show/director');
const { renderIntents } = require('../../src/show/render');
const { COLOR_PRESETS, PATTERNS } = require('../../src/server/presets');

const TRACKS = path.join(__dirname, '..', 'fixtures', 'tracks');
const tracks = fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(TRACKS, f), 'utf8')));

const plan = (doc) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 50,
}).plan(doc);

const WHOLE_RIG = ['solid', 'fade', 'hit', 'strobe', 'split', 'sections', 'ribbon', 'ensemble'];

test('resting passages and whole-rig looks never split', () => {
  for (const doc of tracks) {
    for (const i of plan(doc).intents) {
      if (i.kind !== 'SCENE' || i.split == null) continue;
      assert.ok(!/intro|outro|breakdown/.test(i.source), `${doc.track.name}: ${i.source} split`);
      assert.ok(!WHOLE_RIG.includes(i.pattern), `${doc.track.name}: ${i.pattern} split`);
    }
  }
});

test('some driving passage in the committed tracks splits', () => {
  const splits = tracks.flatMap((doc) => plan(doc).intents.filter((i) => i.kind === 'SCENE' && i.split != null));
  assert.ok(splits.length >= 5, `${splits.length} split scenes across five tracks`);
});

test('a returning passage splits the same way it did the first time', () => {
  for (const doc of tracks) {
    const seen = new Map();
    for (const i of plan(doc).intents) {
      if (i.kind !== 'SCENE' || !i.source.startsWith('section:') || i.split == null) continue;
      const key = `${i.identity}|${i.source}`;
      if (seen.has(key)) assert.strictEqual(i.split, seen.get(key), `${doc.track.name}: ${key}`);
      else seen.set(key, i.split);
    }
  }
});

test('every rendered scene says whether it is split, so none inherits one', () => {
  for (const doc of tracks) {
    const scenes = plan(doc).intents.filter((i) => i.kind === 'SCENE');
    for (const event of renderIntents(scenes)) {
      if (event.action !== 'patch') continue;
      assert.ok('split' in event.data, JSON.stringify(event.data));
    }
  }
});
