// tests/unit/effects-catalogue.test.js
// Hue Dynamics' presets, the Disco genres, the fork's own looks and controls,
// and the pattern list the pickers receive.
import test from 'node:test';
import assert from 'node:assert';
import { CATALOGUE, FAMILIES, presetById, presetIndex } from '../../src/shared/effects/index.ts';
import { KINDS, kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { HD_DEFAULTS, scopedLoopLength } from '../../src/shared/effects/hd.ts';
import { DISCO_PRESETS } from '../../src/shared/effects/disco.ts';
import { STROBE_DEFAULTS } from '../../src/shared/effects/strobe.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { PATTERNS, PRESET_ROWS, PATTERN_IDS, ENERGY_EFFECTS } from '../../src/server/presets.ts';
import { getCatalogs } from '../../src/server/state.ts';
import { LOOKS } from '../../scripts/golden-party-looks.js';

const by = (n) => CATALOGUE.find((p) => p.app === 'hd' && p.name === n).spec;

test("Hue Dynamics presets retain their scoped settings", () => {
  for (const name of ['Ice Strike', 'Neon Pulse', 'Colour Pop', 'Velvet Bloom', 'Solar Flare', 'Rainbow Drop', 'Simple ADSR', 'Neon Domino', 'Bass Bloom', 'Aurora Drift', 'Prism Ricochet', 'Meteor Shower', 'Starlight Scatter', 'Velvet Breath', 'Afterglow Gate', 'Voltage Confetti']) {
    assert.ok(CATALOGUE.some((p) => p.app === 'hd' && p.name === name), name);
  }
  assert.strictEqual(by('Neon Domino').kind, 'hd.positionChase');
  assert.strictEqual(by('Ice Strike').scope, 'singleBeat');
  assert.strictEqual(scopedLoopLength(by('Aurora Drift'), by('Aurora Drift').params), 5);
  assert.strictEqual(scopedLoopLength(by('Neon Domino'), by('Neon Domino').params), 4);
  assert.strictEqual(scopedLoopLength(by('Simple ADSR'), by('Simple ADSR').params), 1);
  assert.ok(by('Neon Domino').palette.length >= 1);
});

test('the eleven Disco presets are in the catalogue', () => {
  // Legacy rows carry no spec, so the filter narrows first.
  assert.strictEqual(CATALOGUE.filter((p) => !p.legacy && p.spec.kind === 'hd.disco').length, 11);
});

test("every public catalogue spec validates", () => {
  for (const p of CATALOGUE.filter((c) => !c.legacy)) assert.doesNotThrow(() => validateSpec(p.spec), p.id);
});

test("own looks retain their legacy pattern ids", () => {
  for (const id of LOOKS) {
    assert.ok(PATTERN_IDS.includes(id), id);
    assert.strictEqual(presetById(id).legacy, true, id);
  }
});

test("PATTERNS contains only legacy rows", () => {
  assert.ok(PATTERNS.some((p) => p.id === 'chase'));
  assert.ok(!PATTERNS.some((p) => p.id === 'ldj.ScatterStrobe'));
  assert.deepStrictEqual(PATTERNS.filter((p) => p.legacy !== true).map((p) => p.id), []);
  assert.strictEqual(PATTERNS.find((p) => p.id === 'position-chase').preset, 'hd.neonDomino');
  assert.ok(!('preset' in PATTERNS.find((p) => p.id === 'chase')));
});

test("preset picker rows carry catalogue metadata", () => {
  const row = PRESET_ROWS.find((p) => p.id === 'ldj.ScatterStrobe');
  assert.strictEqual(row.app, 'ldj');
  assert.ok(row.family);
  assert.strictEqual(row.rapidFlash, true);
  assert.strictEqual(PRESET_ROWS.find((p) => p.name === 'Aurora Drift').scope, 'measure');
  assert.strictEqual(presetById('position-chase').preset, CATALOGUE.find((p) => p.name === 'Neon Domino').id);
  assert.ok(PRESET_ROWS.some((p) => p.id === 'palette-strobe' && !('legacy' in p)));
});

test('ENERGY_EFFECTS keeps its seven ids', () => {
  assert.deepStrictEqual(ENERGY_EFFECTS.map((e) => e.id).sort(), ['blinder', 'color-strobe', 'glow', 'kill', 'palette-strobe', 'uv-wash', 'white-strobe']);
});

// ── Hue Dynamics' sixteen, exactly ──────────────────────────────────────────

// attack, hold, decay, sustain, release, peak
const env = (attack, hold, decay, sustain, release, peak) => ({ attack, hold, decay, sustain, release, peak });
const CHANNEL = env(0.1, 0.1, 0.2, 0.5, 0.2, 1);
const BRIGHTNESS = env(0.04, 0.08, 0.16, 0.16, 0.62, 1);
const rgb = (r, g, b) => ({ colourMode: 'all', singleColour: '#FFFFFF', r, g, b, brightness: BRIGHTNESS });
const SIMPLE = {
  'Ice Strike': { palette: ['#D9FFFF'], curve: 'easeOut',
    envelope: rgb(env(0.01, 0.02, 0.08, 0, 0, 0.85), env(0.01, 0.02, 0.18, 0, 0, 1), env(0.01, 0.02, 0.29, 0, 0, 1)) },
  'Neon Pulse': { palette: ['#FF00FF'], curve: 'easeInOut',
    envelope: rgb(env(0.12, 0, 0.38, 0, 0, 1), env(0, 0, 0, 0, 0, 0), env(0.12, 0, 0.58, 0, 0, 1)) },
  'Colour Pop': { palette: ['#FF7050'], curve: 'linear',
    envelope: { colourMode: 'singleColour', singleColour: '#FF7050', r: CHANNEL, g: CHANNEL, b: CHANNEL, brightness: env(0.01, 0.5, 0.25, 0.25, 0, 1) } },
  'Velvet Bloom': { palette: ['#CC1F59'], curve: 'easeInOut',
    envelope: rgb(env(0.4, 0.05, 0.1, 0.8, 0.45, 0.8), env(0.4, 0.05, 0.1, 0.12, 0.45, 0.12), env(0.2, 0.05, 0.3, 0.35, 0.45, 0.55)) },
  'Solar Flare': { palette: ['#FFD9A6'], curve: 'easeOut',
    envelope: rgb(env(0.01, 0.03, 0.5, 0.18, 0.46, 1), env(0.01, 0.03, 0.32, 0, 0, 0.85), env(0.01, 0.03, 0.09, 0, 0, 0.65)) },
  'Rainbow Drop': { palette: ['#FF0000', '#00CC00', '#000099'], curve: 'easeInOut',
    envelope: rgb(env(0.02, 0.03, 0.24, 0.045, 0.08, 1), env(0.3, 0, 0.32, 0, 0, 0.8), env(0.65, 0, 0.25, 0.07, 0.1, 0.6)) },
  // Not the family's single-colour recommendation: the app gives this preset
  // its own staggered red, green and blue.
  'Simple ADSR': { palette: ['#0080FF'], curve: 'easeOut',
    envelope: rgb(env(0.04, 0.08, 0.2, 0, 0.68, 1), env(0.2, 0, 0.4, 0, 0.4, 0.8), env(0.4, 0, 0, 0.6, 0.6, 0.6)) },
};
const FAMILY_ROWS = {
  'Neon Domino': ['hd.positionChase', ['#FF2BD6', '#7C3AED', '#22D3EE']],
  'Bass Bloom': ['hd.radialPulse', ['#FF006E', '#FB5607', '#FFBE0B']],
  'Aurora Drift': ['hd.spatialWash', ['#06B6D4', '#22C55E', '#6366F1']],
  'Prism Ricochet': ['hd.bouncingScan', ['#F8FAFC', '#A855F7', '#06B6D4', '#F43F5E']],
  'Meteor Shower': ['hd.streak', ['#FFFFFF', '#38BDF8', '#8B5CF6']],
  'Starlight Scatter': ['hd.twinkle', ['#E0F2FE', '#C4B5FD', '#FDF4FF']],
  'Velvet Breath': ['hd.breathingFade', ['#581C87', '#BE185D', '#7E22CE']],
  'Afterglow Gate': ['hd.volumeGateWash', ['#FB7185', '#F97316', '#FACC15']],
  'Voltage Confetti': ['hd.frequencyBurst', ['#FDE047', '#22D3EE', '#F472B6', '#A3E635']],
};
const hdParty = () => CATALOGUE.filter((p) => p.app === 'hd' && p.family !== 'hd.disco');
const withoutEnvelope = ({ curve: _curve, rgbEnvelope: _envelope, ...rest }) => rest;

test("single-beat presets retain their RGB envelopes", () => {
  const family = HD_DEFAULTS['hd.simpleAdsr'];
  for (const [name, want] of Object.entries(SIMPLE)) {
    const spec = by(name);
    assert.strictEqual(spec.kind, 'hd.simpleAdsr', name);
    assert.strictEqual(spec.scope, 'singleBeat', name);
    assert.deepStrictEqual(spec.palette, want.palette, name);
    assert.strictEqual(spec.params.curve, want.curve, name);
    assert.deepStrictEqual(spec.params.rgbEnvelope, want.envelope, name);
    // Everything else is the family's recommendation, output settings included.
    assert.deepStrictEqual(withoutEnvelope(spec.params), withoutEnvelope(family.params), name);
    assert.deepStrictEqual([spec.brightness, spec.rapidFlash, spec.minFlashIntervalMs], [family.brightness, family.rapidFlash, family.minFlashIntervalMs], name);
    assert.strictEqual(scopedLoopLength(spec, spec.params), 1, name);
  }
  // An explicit zero peak stays zero rather than falling back to full.
  assert.strictEqual(by('Neon Pulse').params.rgbEnvelope.g.peak, 0);
});

test("measure presets use family recommendations", () => {
  for (const [name, [kind, palette]] of Object.entries(FAMILY_ROWS)) {
    const spec = by(name);
    const family = HD_DEFAULTS[kind];
    assert.strictEqual(spec.kind, kind, name);
    assert.strictEqual(spec.scope, 'measure', name);
    assert.deepStrictEqual(spec.palette, palette, name);
    assert.deepStrictEqual(spec.params, family.params, name);
    assert.deepStrictEqual([spec.brightness, spec.rapidFlash, spec.minFlashIntervalMs], [family.brightness, family.rapidFlash, family.minFlashIntervalMs], name);
  }
  assert.strictEqual(hdParty().length, 16);
  assert.deepStrictEqual(hdParty().map((p) => p.name), [...Object.keys(SIMPLE), ...Object.keys(FAMILY_ROWS)]);
  assert.strictEqual(hdParty().filter((p) => p.spec.scope === 'singleBeat').length, 7);
  // Stable ids from the preset names; Simple ADSR's is its kind's, as a Light DJ preset's is.
  assert.deepStrictEqual(hdParty().map((p) => p.id), ['hd.iceStrike', 'hd.neonPulse', 'hd.colourPop', 'hd.velvetBloom', 'hd.solarFlare',
    'hd.rainbowDrop', 'hd.simpleAdsr', 'hd.neonDomino', 'hd.bassBloom', 'hd.auroraDrift', 'hd.prismRicochet', 'hd.meteorShower',
    'hd.starlightScatter', 'hd.velvetBreath', 'hd.afterglowGate', 'hd.voltageConfetti']);
  for (const p of hdParty()) {
    assert.strictEqual(p.family, p.spec.kind, p.id);
    assert.strictEqual(p.lengthBeats, undefined, `${p.id}: Hue Dynamics plays its scoped loop, not Light DJ's lifetime`);
    assert.strictEqual(typeof p.desc, 'string', p.id);
  }
  assert.strictEqual(presetById('hd.voltageConfetti').spec.rapidFlash, true);
});

test("built-in settings are independent of family defaults", () => {
  const domino = presetById('hd.neonDomino').spec;
  assert.notStrictEqual(domino.params.spatial, HD_DEFAULTS['hd.positionChase'].params.spatial);
  assert.notStrictEqual(domino.params.trigger, kindOf('hd.positionChase').defaults.params.trigger);
  assert.ok(Object.isFrozen(domino.params.spatial) && !Object.isFrozen(HD_DEFAULTS['hd.positionChase'].params.spatial));
  // The single-colour recommendation survives the six RGB presets built from it.
  assert.strictEqual(HD_DEFAULTS['hd.simpleAdsr'].params.rgbEnvelope.colourMode, 'singleColour');
  assert.strictEqual(HD_DEFAULTS['hd.simpleAdsr'].params.curve, 'linear');
  assert.ok(!Object.isFrozen(HD_DEFAULTS['hd.simpleAdsr'].params.rgbEnvelope.brightness));
  assert.notStrictEqual(presetById('hd.iceStrike').spec.params.rgbEnvelope.brightness, HD_DEFAULTS['hd.simpleAdsr'].params.rgbEnvelope.brightness);
  assert.ok(!Object.isFrozen(DISCO_PRESETS[0].params.channels[0]));
  assert.ok(!Object.isFrozen(kindOf('strobe').defaults.palette));
  assert.throws(() => { presetById('hd.iceStrike').spec.params.rgbEnvelope.r.peak = 1; }, TypeError);
});

// ── Rendering ───────────────────────────────────────────────────────────────

const BEAT_MS = 1000;
const lamp = () => buildRoom(1, () => 0.5, () => 0.5, () => 0.5, null);
const frameAt = (beat, look) => ({ beatPos: beat, bpm: 60000 / BEAT_MS, nowMs: beat * BEAT_MS, dtMs: 1000 / 44, anchorBeat: 0,
  lookPalette: look, paletteOverride: null, audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: seedFrom('catalogue'),
  acknowledged: true, hueStrobe: 'flash' });
function sample(spec, beat, look = [parseHex('#FF0000')]) {
  const out = [];
  renderEffect({ id: 'sample', spec, seed: seedFrom('catalogue'), anchorBeat: 0, startedAtMs: 0, targets: null }, frameAt(beat, look), lamp(), new EffectStepper(), out);
  return out[0];
}

test("Neon Pulse follows its red and blue envelopes", () => {
  const peak = sample(by('Neon Pulse'), 0.12);
  assert.deepStrictEqual([peak.colour.r, peak.colour.g, peak.colour.b, peak.level], [255, 0, 255, 1]);
  const late = sample(by('Neon Pulse'), 0.5);
  assert.deepStrictEqual([late.colour.r, late.colour.g, late.colour.b], [0, 0, 255]);
  assert.ok(late.level > 0.1 && late.level < 0.2, `blue still falling: ${late.level}`);
});

test("Colour Pop follows its single-colour brightness envelope", () => {
  const coral = [255, 112, 80];
  const full = sample(by('Colour Pop'), 0.25), rest = sample(by('Colour Pop'), 0.9);
  assert.deepStrictEqual([full.colour.r, full.colour.g, full.colour.b, full.level], [...coral, 1]);
  assert.deepStrictEqual([rest.colour.r, rest.colour.g, rest.colour.b], coral);
  assert.ok(Math.abs(rest.level - 0.25) < 1e-9, `sustain a quarter: ${rest.level}`);
});

test("Simple ADSR staggers red, green and blue", () => {
  const early = sample(by('Simple ADSR'), 0.1), late = sample(by('Simple ADSR'), 0.5);
  assert.ok(early.colour.r === 255 && early.colour.g < 255 && early.colour.b < early.colour.g, JSON.stringify(early.colour));
  assert.ok(late.colour.b === 255 && late.colour.r === 0 && late.colour.g < 255, JSON.stringify(late.colour));
});

test("catalogue presets render finite single-lamp output", () => {
  const added = CATALOGUE.filter((p) => !p.legacy && p.app !== 'ldj');
  assert.strictEqual(added.length, 34);
  for (const p of added) {
    const spec = { ...p.spec, palette: ['#00FF00'] };
    const inst = { id: p.id, spec, seed: seedFrom(p.id), anchorBeat: 0, startedAtMs: 0, targets: null };
    const stepper = new EffectStepper();
    let brightest = 0;
    for (let ms = 0; ms <= 16 * BEAT_MS; ms += 1000 / 44) {
      const out = [];
      renderEffect(inst, { ...frameAt(ms / BEAT_MS, [parseHex('#00FF00')]), seed: inst.seed }, lamp(), stepper, out);
      const slot = out[0];
      assert.ok([slot.level, slot.strength, ...Object.values(slot.colour)].every(Number.isFinite), `${p.id} at ${ms} ms`);
      brightest = Math.max(brightest, slot.level * slot.strength);
    }
    assert.strictEqual(brightest > 0.01, p.id !== 'energy.kill', p.id);
  }
});

// ── Disco, the own looks and the controls ───────────────────────────────────

test("Disco presets share their genre catalogue", () => {
  const disco = CATALOGUE.filter((p) => p.family === 'hd.disco');
  assert.deepStrictEqual(disco.map((p) => [p.id, p.name]), DISCO_PRESETS.map((p) => [p.id, p.name]));
  disco.forEach((p, i) => {
    assert.strictEqual(p.app, 'hd');
    assert.deepStrictEqual(p.spec.params, DISCO_PRESETS[i].params, p.id);
    assert.strictEqual(typeof p.desc, 'string', p.id);
    // The automatic strobe asks for the acknowledgement itself, when it fires.
    assert.strictEqual(requiresAcknowledgement(p.spec), false, p.id);
  });


});

// The own looks modelled on a Hue Dynamics preset, and the preset they offer beside them.
const LINKS = {
  'position-chase': 'Neon Domino', 'radial-pulse': 'Bass Bloom', 'spatial-wash': 'Aurora Drift', 'bounce-scan': 'Prism Ricochet',
  streak: 'Meteor Shower', starlight: 'Starlight Scatter', breathe: 'Velvet Breath', 'volume-gate': 'Afterglow Gate', confetti: 'Voltage Confetti',
};

test("own looks retain legacy pattern metadata", () => {
  const legacy = CATALOGUE.filter((p) => p.legacy);
  assert.deepStrictEqual(legacy.map((p) => p.id), LOOKS);
  for (const p of legacy) {
    assert.ok(!('spec' in p), `${p.id} has no effect to render`);
    assert.ok(p.id in PATTERN_FUNCS, p.id);
    assert.deepStrictEqual([p.app, p.family, p.party], ['own', 'own.party', true], p.id);
    const pattern = PATTERNS.find((x) => x.id === p.id);
    assert.deepStrictEqual({ id: p.id, name: p.name, desc: p.desc, party: true, legacy: true, ...(p.preset ? { preset: p.preset } : {}) }, pattern, p.id);
    if (p.id in LINKS) {
      const target = presetById(p.preset);
      assert.strictEqual(target.name, LINKS[p.id], p.id);
      assert.ok(target.app === 'hd' && !target.legacy, p.id);
    } else {
      assert.ok(!('preset' in p), `${p.id} claims no equivalent`);
    }
  }
  // A link is an offer in the picker, never an alias.
  assert.strictEqual(presetById('position-chase').id, 'position-chase');
});

test("control presets resolve to energy and strobe kinds", () => {
  const controls = CATALOGUE.filter((p) => p.family === 'own.energy');
  assert.deepStrictEqual(controls.map((p) => [p.id, p.aliases ?? []]), [
    ['energy.whiteStrobe', ['white-strobe']], ['energy.colorStrobe', ['color-strobe']], ['energy.blinder', ['blinder']],
    ['energy.uvWash', ['uv-wash']], ['energy.kill', ['kill']], ['energy.glow', ['glow']], ['palette-strobe', []],
  ]);
  for (const p of controls.slice(0, 6)) {
    assert.deepStrictEqual(p.spec, { kind: p.id, params: {}, brightness: 1 }, p.id);
    assert.strictEqual(presetById(p.aliases[0]), p, p.aliases[0]);
  }
  // The compatibility strobe: the look's colours, five a second on the beat grid, the look showing between.
  assert.deepStrictEqual(presetById('palette-strobe').spec, {
    kind: 'strobe', palette: null, brightness: 1,
    params: { flashesPerSecond: 5, continueBetween: true, clock: 'beat', brightness: 1, onMs: 100, blackMs: 100 },
  });
  // The manual strobe keeps its own white at two a second.
  assert.deepStrictEqual(validateSpec({ kind: 'strobe' }).palette, ['#FFFFFF']);
  assert.strictEqual(STROBE_DEFAULTS.flashesPerSecond, 2);
  // `strobe` is the upstream pattern's id; no control may take it.
  assert.strictEqual(presetById('strobe'), null);
  assert.deepStrictEqual(ENERGY_EFFECTS.map((e) => e.id), ['white-strobe', 'color-strobe', 'blinder', 'uv-wash', 'kill', 'glow', 'palette-strobe']);
  assert.deepStrictEqual(ENERGY_EFFECTS.map((e) => e.name), ['White Strobe', 'Colour Strobe', 'Blinder', 'UV Wash', 'Kill', 'Glow', 'Palette Strobe']);
  for (const e of ENERGY_EFFECTS) assert.deepStrictEqual(e, { id: e.id, name: presetById(e.id).name, desc: presetById(e.id).desc });
});

test("catalogue ids are unique across apps and legacy patterns", () => {
  assert.strictEqual(CATALOGUE.length, 214);
  assert.strictEqual(CATALOGUE.filter((p) => !p.legacy).length, 196);
  const count = (app) => CATALOGUE.filter((p) => p.app === app).length;
  assert.deepStrictEqual([count('ldj'), count('hd'), count('own')], [162, 27, 25]);
  const keys = CATALOGUE.flatMap((p) => [p.id, ...(p.aliases ?? [])]);
  assert.strictEqual(new Set(keys).size, keys.length);
  for (const p of CATALOGUE.filter((c) => !c.legacy)) {
    for (const key of [p.id, ...(p.aliases ?? [])]) assert.ok(!PATTERN_IDS.includes(key), `${key} is a legacy pattern id`);
  }
  assert.ok(Object.isFrozen(CATALOGUE) && CATALOGUE.every(Object.isFrozen));
});

test("preset ids cannot shadow legacy patterns", () => {
  const spec = validateSpec({ kind: 'energy.kill' });
  const row = (id, extra = {}) => ({ id, name: id, desc: '', app: 'own', family: 'own', spec, ...extra });
  assert.throws(() => presetIndex([row('strobe')]), Error);
  assert.throws(() => presetIndex([row('x', { aliases: ['chase'] })]), Error);
});

test("legacy rows require a matching pattern function", () => {
  assert.throws(() => presetIndex([{ id: 'no-such-look', name: '', desc: '', app: 'own', family: 'own.party', legacy: true }]), Error);
  assert.throws(() => presetIndex([{ id: 'chase', name: '', desc: '', app: 'own', family: 'own.party', legacy: true, aliases: ['old-chase'] }]), Error);
  assert.strictEqual(presetIndex([{ id: 'chase', name: '', desc: '', app: 'own', family: 'own.party', legacy: true }]).get('chase').id, 'chase');
});

test('built-in specs validate twice to themselves', () => {
  for (const p of CATALOGUE.filter((c) => !c.legacy && c.app !== 'ldj')) {
    const once = validateSpec(p.spec);
    assert.deepStrictEqual(once, p.spec, p.id);
    assert.deepStrictEqual(validateSpec(once), once, p.id);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.spec)), p.spec, p.id);
  }
});

// ── Families and the wire list ──────────────────────────────────────────────

test("Hue Dynamics families expose independent recommendations", () => {
  const hd = FAMILIES.filter((f) => f.app === 'hd');
  assert.deepStrictEqual(hd.map((f) => [f.id, f.name]), [
    ['hd.simpleAdsr', 'Simple ADSR'], ['hd.positionChase', 'Position Chase'], ['hd.radialPulse', 'Radial Pulse'], ['hd.spatialWash', 'Spatial Wash'],
    ['hd.bouncingScan', 'Bouncing Scan'], ['hd.streak', 'Streak'], ['hd.twinkle', 'Twinkle'], ['hd.breathingFade', 'Breathing Fade'],
    ['hd.volumeGateWash', 'Volume Gate Wash'], ['hd.frequencyBurst', 'Frequency Burst'], ['hd.disco', 'Disco'],
  ]);
  for (const family of hd) {
    assert.deepStrictEqual(family.kinds.map((k) => k.kind), [family.id]);
    const [entry] = family.kinds, def = kindOf(family.id);
    assert.deepStrictEqual(entry.defaults, JSON.parse(JSON.stringify(def.defaults)), family.id);
    assert.notStrictEqual(entry.defaults, def.defaults, family.id);
    assert.deepStrictEqual(entry.capabilities, def.capabilities ? JSON.parse(JSON.stringify(def.capabilities)) : null, family.id);
    // Freezing the families must leave the registry's own inspector data editable.
    if (def.capabilities) assert.ok(entry.capabilities !== def.capabilities && !Object.isFrozen(def.capabilities), family.id);
  }
  const caps = (id) => FAMILIES.find((f) => f.id === id).kinds[0].capabilities;
  assert.strictEqual(caps('hd.radialPulse')['spatial.x'], true);
  assert.strictEqual(caps('hd.spatialWash')['spatial.angle'], true);
  assert.strictEqual(caps('hd.spatialWash')['spatial.x'], false);
});

test("families cover every public engine kind", () => {
  const hd = FAMILIES.filter((f) => f.app === 'hd');
  assert.deepStrictEqual(FAMILIES.find((f) => f.id === 'own.party').kinds, []);
  assert.deepStrictEqual(FAMILIES.find((f) => f.id === 'own.energy').kinds.map((k) => k.kind),
    ['energy.whiteStrobe', 'energy.colorStrobe', 'energy.blinder', 'energy.uvWash', 'energy.kill', 'energy.glow', 'strobe']);
  assert.deepStrictEqual(FAMILIES.map((f) => [f.id, f.app]), [
    ...['channel', 'iteration', 'rotation', 'wave', 'matrix', 'studio', 'visualizer', 'bitmap', 'macro'].map((e) => [`ldj.${e}`, 'ldj']),
    ...hd.map((f) => [f.id, 'hd']), ['own.party', 'own'], ['own.energy', 'own'],
  ]);
  assert.deepStrictEqual(FAMILIES.filter((f) => f.app === 'own').map((f) => f.name), ['Party Looks', 'Energy']);
  const listed = FAMILIES.flatMap((f) => f.kinds.map((k) => k.kind)).sort();
  const internal = [...KINDS.values()].filter((d) => d.internal).map((d) => d.kind);
  assert.deepStrictEqual(internal, ['pattern.bundle']);
  assert.ok(!listed.includes('pattern.bundle'));
  assert.deepStrictEqual(listed, [...KINDS.keys()].filter((k) => !internal.includes(k)).concat('ldj.SceneMakerFirework').sort(), 'every public kind once, the firework renderer twice');
  for (const p of CATALOGUE) assert.ok(FAMILIES.some((f) => f.id === p.family), `${p.id}: family ${p.family}`);
});

test("family metadata remains plain wire data", () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(FAMILIES)), FAMILIES, 'no functions or schemas');
});

test("pickers expose every preset with effective acknowledgement", () => {
  assert.deepStrictEqual(PATTERNS.map((p) => p.id), PATTERN_IDS);
  assert.deepStrictEqual(PRESET_ROWS.map((p) => p.id), CATALOGUE.filter((p) => !p.legacy).map((p) => p.id));
  for (const row of PRESET_ROWS) {
    const p = presetById(row.id);
    assert.deepStrictEqual(Object.keys(row), ['id', 'name', 'desc', 'app', 'family', 'rapidFlash', 'scope'], row.id);
    assert.deepStrictEqual([row.name, row.desc, row.app, row.family], [p.name, p.desc, p.app, p.family], row.id);
    assert.strictEqual(row.rapidFlash, requiresAcknowledgement(p.spec), row.id);
    assert.strictEqual(row.scope, p.spec.scope ?? null, row.id);
  }
  const rapid = (id) => PRESET_ROWS.find((p) => p.id === id).rapidFlash;
  // Parameter-dependent: a quarter-beat cadence and a macro with a rapid step both need it.
  assert.deepStrictEqual(['ldj.ScatterStrobe', 'ldj.House', 'ldj.Blackout', 'ldj.FadeCycle', 'hd.voltageConfetti', 'hd.neonDomino', 'palette-strobe', 'energy.blinder']
    .map(rapid), [true, true, false, false, true, false, true, false]);
  const patterns = getCatalogs().patterns;
  assert.deepStrictEqual(patterns, [...PATTERNS, ...PRESET_ROWS]);
  assert.strictEqual(new Set(patterns.map((p) => p.id)).size, patterns.length, 'no id listed twice');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(patterns)), patterns);
});

test("wall-clock kinds advertise their timing", () => {
  const entries = FAMILIES.flatMap((f) => f.kinds);
  const flagged = entries.filter((k) => k.wallClock).map((k) => k.kind);
  assert.ok(flagged.includes('ldj.TrueStrobe'), `flagged: ${flagged}`);
  for (const entry of entries) {
    const def = kindOf(entry.kind);
    assert.strictEqual(entry.wallClock, def.wallClock ? true : undefined, entry.kind);
    // The flag is the row's clock, read off what the kind does: on the wall clock it is rapid at any cadence.
    if (entry.wallClock) assert.strictEqual(def.rapidFlashWhen({ cadence: 8, beats: 32 }), true, entry.kind);
    if (!entry.kind.startsWith('ldj.')) assert.strictEqual(entry.wallClock, undefined, entry.kind);
  }
  assert.ok(entries.some((k) => k.kind.startsWith('ldj.') && !k.wallClock), 'the beat-clocked rows carry no flag');
});
