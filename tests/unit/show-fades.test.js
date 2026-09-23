// Every scene change used to be a cut. The show now fades where the music
// settles and cuts where it hits: long into a breakdown or an outro, none into
// a chorus or a drop.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { ShowDirector } from '../../src/show/director.ts';
import { renderIntents } from '../../src/show/render.ts';
import { patchSchema } from '../../src/server/validation.js';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const tracks = fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(TRACKS, f), 'utf8')));

const plan = (doc) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 50,
}).plan(doc);

const sectionScenes = (intents, roles) => intents.filter((i) => i.kind === 'SCENE'
  && roles.includes(i.source.replace('section:', '')) && i.timeMs > 500);

test('a chorus or a drop arrives on the beat, not faded in', () => {
  for (const doc of tracks) {
    for (const s of sectionScenes(plan(doc).intents, ['chorus', 'drop'])) {
      assert.ok(!s.fadeMs, `${doc.track.name}: ${s.source} at ${s.timeMs} fades ${s.fadeMs} ms`);
    }
  }
});

test('the music settling into a breakdown or an outro is a fade of about two bars', () => {
  let seen = 0;
  for (const doc of tracks) {
    const { intents, context } = plan(doc);
    for (const s of sectionScenes(intents, ['breakdown', 'outro'])) {
      seen++;
      assert.ok(s.fadeMs >= 1000 && s.fadeMs <= 4000, `${doc.track.name}: ${s.source} fades ${s.fadeMs} ms`);
      assert.ok(Math.abs(s.fadeMs - Math.min(4000, 2 * context.barSec * 1000)) < 2, 'two bars, capped');
    }
  }
  // Two in the committed fixtures: the rest keep the look already on stage.
  assert.ok(seen >= 2, `only ${seen} resting sections across the fixtures`);
});

test('the opening look is simply there', () => {
  for (const doc of tracks) {
    const first = plan(doc).intents.find((i) => i.kind === 'SCENE');
    assert.ok(!first.fadeMs, doc.track.name);
  }
});

test('every fade the show asks for is one the engine accepts', () => {
  let fades = 0;
  for (const doc of tracks) {
    for (const event of renderIntents(plan(doc).intents)) {
      if (event.action !== 'patch' || event.data.fadeMs === undefined) continue;
      fades++;
      assert.ok(patchSchema.safeParse(event.data).success, JSON.stringify(event.data));
    }
  }
  assert.ok(fades > 20, `only ${fades} fades across five tracks`);
});
