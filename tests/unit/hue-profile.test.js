// A Hue lamp's profile is built from what its bridge says the lamp can show:
// its gamut, the whites it tunes between, and the sections it is split into.

import test from 'node:test';
import assert from 'node:assert';

import { hueProfile, hueProfileId } from '../../src/server/hue-profile.ts';
import { capabilitiesOf, lampsOf } from '../../src/server/hue.ts';
import { isHueProfile, hueSections, hueChannelsLabel, kelvinColour } from '../../src/shared/hue-lamp.ts';
import { isBuiltinProfile } from '../../src/server/profiles.ts';
import { areaLamp, HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT } from './hue-test-lamps.js';

// ── Reading the bridge ───────────────────────────────────────────────────────

test('a light\'s gamut and range of whites are read off its resource, in kelvin', () => {
  assert.deepStrictEqual(capabilitiesOf({
    color: { gamut_type: 'C' }, color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
  }), { gamut: 'C', whites: { warm: 2000, cool: 6536 }, fixedWhite: null });
  assert.deepStrictEqual(capabilitiesOf({ color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 454 } } }),
    { gamut: null, whites: { warm: 2203, cool: 6536 }, fixedWhite: null }, 'a tunable white');
  assert.deepStrictEqual(capabilitiesOf({ metadata: { fixed_mired: 366 } }),
    { gamut: null, whites: null, fixedWhite: 2732 }, 'a white that only dims says which white it is');
  assert.deepStrictEqual(capabilitiesOf({}), { gamut: null, whites: null, fixedWhite: null });
});

test('what the bridge says is held to what makes sense', () => {
  assert.strictEqual(capabilitiesOf({ color: { gamut_type: 'Z' } }).gamut, 'other', 'a gamut it does not name');
  assert.strictEqual(capabilitiesOf({ color: {} }).gamut, 'other');
  assert.strictEqual(capabilitiesOf({ color_temperature: { mirek_schema: { mirek_minimum: 'x', mirek_maximum: 500 } } }).whites, null);
  assert.strictEqual(capabilitiesOf({ color_temperature: { mirek_schema: { mirek_minimum: 500, mirek_maximum: 153 } } }).whites, null,
    'warmest and coolest the wrong way round');
  assert.strictEqual(capabilitiesOf({ metadata: { fixed_mired: 5 } }).fixedWhite, null, 'no such white');
});

const segment = (rid, index) => ({ service: { rid, rtype: 'entertainment' }, index });
const NAMES = new Map([
  ['strip', { name: 'TV strip', product: 'Hue gradient lightstrip', device: 'd-strip', kind: 'color', capabilities: { gamut: 'C', whites: null, fixedWhite: null } }],
  ['bulb', { name: 'Shelf', product: 'Hue color lamp', device: 'd-bulb', kind: 'color', capabilities: { gamut: 'C', whites: null, fixedWhite: null } }],
]);

test('a gradient lamp\'s channels are one lamp, its sections in order along it', () => {
  const lamps = lampsOf([
    { channel_id: 0, members: [segment('bulb', 0)] },
    { channel_id: 4, members: [segment('strip', 2)] },
    { channel_id: 2, members: [segment('strip', 0)] },
    { channel_id: 3, members: [segment('strip', 1)] },
  ], NAMES);
  assert.deepStrictEqual(lamps.map((l) => [l.id, l.name, l.channels]), [
    ['bulb', 'Shelf', [0]],
    ['strip', 'TV strip', [2, 3, 4]],
  ]);
  assert.deepStrictEqual(lamps[1].devices, ['d-strip']);
  assert.strictEqual(lamps[1].product, 'Hue gradient lightstrip');
  assert.deepStrictEqual(lamps[1].capabilities, { gamut: 'C', whites: null, fixedWhite: null });
});

test('a channel the bridge says nothing about is a lamp of its own, unread', () => {
  const [lamp] = lampsOf([{ channel_id: 6, members: [] }], NAMES);
  assert.deepStrictEqual([lamp.id, lamp.name, lamp.channels, lamp.capabilities], ['channel-6', '', [6], null]);
  assert.strictEqual(hueProfile(lamp), null, 'and gets no profile until it can be read');
});

// ── The profile ──────────────────────────────────────────────────────────────

test('a colour lamp that tunes white is a dimmer, RGB, its two whites and UV', () => {
  assert.strictEqual(HUE_COLOR.id, hueProfileId('test-color'));
  assert.deepStrictEqual(HUE_COLOR.channelMap, { dimmer: 0, red: 1, green: 2, blue: 3, warmWhite: 4, coolWhite: 5, uv: 6 });
  assert.deepStrictEqual(HUE_COLOR.channelList.map((c) => c.name),
    ['Dimmer', 'Red', 'Green', 'Blue', 'White 2000 K', 'White 6500 K', 'UV (shown as violet)'], 'its whites named for the lamp\'s own');
  assert.deepStrictEqual(HUE_COLOR.hue, { gamut: 'C', whites: { warm: 2000, cool: 6536 } });
  assert.strictEqual(HUE_COLOR.modeName, 'colour (gamut C), white 2000 K–6500 K');
});

test('the name is the product as the bridge gives it, with nothing in front', () => {
  assert.strictEqual(HUE_COLOR.name, 'Hue color lamp');
  assert.strictEqual(HUE_COLOR.manufacturer, undefined);
  assert.strictEqual(hueProfile(areaLamp({ id: 'x', product: '' })).name, 'Hue lamp');
});

test('a colour lamp that does not tune white has no white dies', () => {
  const profile = hueProfile(areaLamp({ id: 'bloom', whites: null }));
  assert.deepStrictEqual(profile.channelMap, { dimmer: 0, red: 1, green: 2, blue: 3, uv: 4 });
  assert.strictEqual(profile.modeName, 'colour (gamut C)');
});

test('a tunable white is its two whites and no colour', () => {
  assert.deepStrictEqual(HUE_AMBIANCE.channelMap, { dimmer: 0, warmWhite: 1, coolWhite: 2 });
  assert.strictEqual(HUE_AMBIANCE.modeName, 'white 2200 K–6500 K');
});

test('a lamp that only dims is a dimmer, at the white it says it is', () => {
  assert.deepStrictEqual(HUE_WHITE.channelMap, { dimmer: 0 });
  assert.deepStrictEqual(HUE_WHITE.hue.whites, { warm: 2732, cool: 2732 });
  assert.strictEqual(HUE_WHITE.modeName, 'white 2700 K');
  const unsaid = hueProfile(areaLamp({ id: 'w', gamut: null, whites: null }));
  assert.deepStrictEqual([unsaid.channelMap, unsaid.hue.whites, unsaid.modeName], [{ dimmer: 0 }, null, 'white']);
});

test('no Hue lamp claims a strobe channel: the bridge would drop it', () => {
  for (const profile of [HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT]) {
    assert.ok(!profile.channelList.some((c) => c.attribute === 'strobe'), profile.id);
  }
});

test('a gradient lamp is a cell a section, each with its own dimmer and colour', () => {
  assert.strictEqual(HUE_GRADIENT.cells.length, 5);
  assert.strictEqual(hueSections(HUE_GRADIENT), 5);
  assert.deepStrictEqual(HUE_GRADIENT.channelMap, {}, 'nothing for the whole lamp');
  assert.deepStrictEqual(HUE_GRADIENT.cells[1].channelMap, { dimmer: 7, red: 8, green: 9, blue: 10, warmWhite: 11, coolWhite: 12, uv: 13 });
  assert.strictEqual(HUE_GRADIENT.channelCount, 35);
  assert.deepStrictEqual(HUE_GRADIENT.cells.map((c) => c.name), ['Section 1', 'Section 2', 'Section 3', 'Section 4', 'Section 5']);
  assert.ok(HUE_GRADIENT.channelList.every((c) => c.cell === Math.floor(c.offset / 7)));
  assert.strictEqual(HUE_GRADIENT.modeName, '5 sections, colour (gamut C), white 2000 K–6500 K');
});

test('a Hue lamp\'s profile says so, and is never a built-in', () => {
  for (const profile of [HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT]) {
    assert.strictEqual(isHueProfile(profile), true);
    assert.strictEqual(isBuiltinProfile(profile.id), false);
  }
  assert.strictEqual(isHueProfile({ id: 'par', channelMap: {} }), false);
  assert.strictEqual(hueSections(HUE_COLOR), 1);
});

test('channels read as a person reads them', () => {
  assert.strictEqual(hueChannelsLabel([3]), 'channel #3');
  assert.strictEqual(hueChannelsLabel([3, 4, 5]), 'channels #3–#5');
  assert.strictEqual(hueChannelsLabel([3, 7]), 'channels #3, #7');
});

test('a white\'s colour follows the blackbody curve', () => {
  const tungsten = kelvinColour(2700);
  assert.strictEqual(tungsten.r, 1);
  assert.ok(Math.abs(tungsten.g - 0.65) < 0.02 && Math.abs(tungsten.b - 0.34) < 0.02, JSON.stringify(tungsten));
  const daylight = kelvinColour(6536);
  assert.ok(daylight.r > 0.97 && daylight.g > 0.95 && daylight.b > 0.95, JSON.stringify(daylight));
  assert.ok(kelvinColour(2000).b < tungsten.b, 'warmer is less blue');
});
