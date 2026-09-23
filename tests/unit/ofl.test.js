// Open Fixture Library import: real fixtures from the library (see
// tests/fixtures/ofl/README.md) and small made-up ones for each rule the
// importer follows.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { parseOfl } from '../../src/server/ofl.ts';
import { profileSchema, validate } from '../../src/server/validation.ts';

const DIR = path.join(import.meta.dirname, '..', 'fixtures', 'ofl');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const read = (name, manufacturer = 'Maker') => parseOfl(load(name), { manufacturer });
const modeOf = (fixture, name) => {
  const mode = fixture.modes.find((m) => m.modeName === name);
  assert.ok(mode, `no mode "${name}" in ${fixture.modes.map((m) => m.modeName).join(', ')}`);
  return mode;
};
const warned = (mode, pattern) => (mode.warnings || []).some((w) => pattern.test(w));

// A made-up fixture: channels, then modes as { name: [channel keys] }.
function fixture(availableChannels, modes, extra = {}) {
  return {
    name: 'Test Fixture',
    availableChannels,
    modes: Object.entries(modes).map(([name, channels]) => ({ name, channels })),
    ...extra,
  };
}
const one = (json) => parseOfl(json, { manufacturer: 'Acme' }).modes[0];
const RGB = {
  'Red $pixelKey': { capability: { type: 'ColorIntensity', color: 'Red' } },
  'Green $pixelKey': { capability: { type: 'ColorIntensity', color: 'Green' } },
  'Blue $pixelKey': { capability: { type: 'ColorIntensity', color: 'Blue' } },
};

// ── The library's own fixtures ──────────────────────────────────────────────

test('every mode of every saved fixture is a profile the patch accepts', () => {
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const fixtureRead = parseOfl(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')), { manufacturer: 'Maker' });
    assert.ok(fixtureRead.modes.length > 0, file);
    for (const mode of fixtureRead.modes) {
      const { warnings: _w, ...profile } = mode;
      validate(profileSchema, { id: 'test', name: fixtureRead.name, manufacturer: fixtureRead.manufacturer, ...profile }, `${file} ${mode.modeName}`);
    }
  }
});

test('ROOT PAR 6: a 16-bit dimmer, the strobe, and RGBWA+UV', () => {
  const par = read('cameo_root-par-6', 'Cameo');
  assert.strictEqual(par.name, 'ROOT PAR 6');
  assert.strictEqual(par.manufacturer, 'Cameo');
  assert.strictEqual(par.modes.length, 14);
  const mode = modeOf(par, '11-channel');
  assert.strictEqual(mode.channelCount, 11);
  assert.deepStrictEqual(mode.channelMap, {
    dimmer: 0, dimmerFine: 1, strobe: 2, red: 3, green: 4, blue: 5, white: 6, amber: 7, uv: 8,
  });
  assert.strictEqual(mode.cells, undefined);
  assert.strictEqual(mode.defaults, undefined, 'every undriven channel is at rest at 0');
  assert.deepStrictEqual(mode.channelList.slice(0, 3).map((c) => [c.name, c.attribute]),
    [['Dimmer', 'dimmer'], ['Dimmer fine', 'dimmerFine'], ['Strobe Multifunctional', 'strobe']]);
  assert.deepStrictEqual(mode.channelList.slice(9).map((c) => c.attribute), ['colorPreset', 'effect']);
});

test('Stairville LED Bar 240/8: eight cells of RGB, one after another', () => {
  const bar = read('stairville_led-bar-240-8');
  const pixels = modeOf(bar, '24-channel');
  assert.strictEqual(pixels.cells.length, 8);
  pixels.cells.forEach((cell, i) => {
    assert.strictEqual(cell.name, `Pixel ${i + 1}`);
    assert.deepStrictEqual(cell.channelMap, { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 });
  });
  assert.deepStrictEqual(pixels.channelMap, {});
  assert.deepStrictEqual(pixels.channelList[4], { offset: 4, name: 'Green 2', attribute: 'green', cell: 1 });

  // Open at 0–2 and strobing from 3: the show's strobe.
  assert.deepStrictEqual(modeOf(bar, '5-channel').channelMap, { red: 0, green: 1, blue: 2, dimmer: 3, strobe: 4 });

  const programs = modeOf(bar, '2-channel');
  assert.ok(warned(programs, /"Show Speed \/ Sound Sensitivity" is read as "Show Speed"/));
  assert.ok(warned(programs, /drives nothing/));
});

test('Showtec Pixel Bar 12 MkII: cells in the order they sit, not the order they are numbered', () => {
  const bar = read('showtec_pixel-bar-12-mkii');
  // Its pixels are numbered 12 … 1 from left to right, and patched 1 … 12.
  const pixels = modeOf(bar, 'RGB Individual');
  assert.strictEqual(pixels.cells.length, 12);
  assert.deepStrictEqual(pixels.cells.map((c) => c.name).slice(0, 3), ['Pixel 12', 'Pixel 11', 'Pixel 10']);
  assert.deepStrictEqual(pixels.cells[0].channelMap, { red: 33, green: 34, blue: 35 });
  assert.deepStrictEqual(pixels.cells[11].channelMap, { red: 0, green: 1, blue: 2 });

  // Halves by position: "2/2" is x ≤ 6, the left half, patched second.
  const halves = modeOf(bar, 'RGB Halves');
  assert.deepStrictEqual(halves.cells, [
    { name: 'Group 2/2', channelMap: { red: 3, green: 4, blue: 5 } },
    { name: 'Group 1/2', channelMap: { red: 0, green: 1, blue: 2 } },
  ]);

  // The Master group is every pixel: the fixture's own colour.
  assert.deepStrictEqual(modeOf(bar, 'RGBD + Effects').channelMap, { red: 0, green: 1, blue: 2, dimmer: 3, strobe: 6 });
});

test('Varytec Giga Bar: a strobe the library says strobes at 0 is left to the software strobe', () => {
  const mode = modeOf(read('varytec_giga-bar-frost-pix-8-rgb'), '5-channel');
  assert.deepStrictEqual(mode.channelMap, { red: 0, green: 1, blue: 2, dimmer: 3 });
  assert.strictEqual(mode.channelList[4].attribute, 'strobe');
  assert.ok(warned(mode, /"Strobe" does not strobe as the show expects/));
});

test('ADJ Mega Bar RGBA: amber, and a switching channel read as it is at rest', () => {
  const bar = read('american-dj_mega-bar-rgba');
  const eighths = modeOf(bar, 'Eighths');
  assert.strictEqual(eighths.cells.length, 8);
  assert.deepStrictEqual(eighths.cells[7].channelMap, { red: 28, green: 29, blue: 30, amber: 31 });
  assert.deepStrictEqual(eighths.channelMap, { strobe: 32, dimmer: 33 });

  const program = modeOf(bar, 'Program');
  assert.strictEqual(program.channelMap.amber, 3);
  assert.strictEqual(program.channelList[3].name, 'Amber Master / Flow Color Macro');
  assert.ok(warned(program, /is read as "Amber Master": it changes with "Programs", which sits at 0/));
});

// ── Each rule on a made-up fixture ──────────────────────────────────────────

test('perChannel repeats each template channel across the pixels before the next', () => {
  const mode = one(fixture({}, {}, {
    matrix: { pixelCount: [4, 1, 1] },
    templateChannels: RGB,
    modes: [{ name: 'Pixels', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelABC', channelOrder: 'perChannel', templateChannels: ['Red $pixelKey', 'Green $pixelKey', 'Blue $pixelKey'] }] }],
  }));
  assert.deepStrictEqual(mode.cells.map((c) => c.channelMap), [0, 1, 2, 3].map((i) => ({ red: i, green: 4 + i, blue: 8 + i })));
});

test('a grid is laid along one line, row by row, and says so', () => {
  const mode = one(fixture({}, {}, {
    matrix: { pixelCount: [3, 2, 1] },
    templateChannels: RGB,
    modes: [{ name: 'Grid', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelYXZ', channelOrder: 'perPixel', templateChannels: ['Red $pixelKey', 'Green $pixelKey', 'Blue $pixelKey'] }] }],
  }));
  // Patched a column at a time; laid out a row at a time.
  assert.deepStrictEqual(mode.cells.map((c) => c.name), ['Pixel (1, 1)', 'Pixel (2, 1)', 'Pixel (3, 1)', 'Pixel (1, 2)', 'Pixel (2, 2)', 'Pixel (3, 2)']);
  assert.deepStrictEqual(mode.cells[1].channelMap, { red: 6, green: 7, blue: 8 });
  assert.ok(warned(mode, /3 × 2 grid; they are laid along one line/));
});

test('a switching channel is what it is at its trigger\'s default', () => {
  const trigger = (defaultValue) => ({
    Mode: {
      defaultValue,
      capabilities: [
        { dmxRange: [0, 127], type: 'Effect', switchChannels: { 'Macro / Dimmer': 'Macro' } },
        { dmxRange: [128, 255], type: 'NoFunction', switchChannels: { 'Macro / Dimmer': 'Dimmer' } },
      ],
    },
    Macro: { capability: { type: 'ColorPreset' } },
    Dimmer: { capability: { type: 'Intensity' } },
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
  });
  const dimmer = one(fixture(trigger(200), { M: ['Mode', 'Macro / Dimmer', 'Red'] }));
  assert.deepStrictEqual(dimmer.channelMap, { dimmer: 1, red: 2 });
  assert.deepStrictEqual(dimmer.defaults, [{ offset: 0, value: 200 }], 'the trigger is held where it was read');
  const macro = one(fixture(trigger(0), { M: ['Mode', 'Macro / Dimmer', 'Red'] }));
  assert.deepStrictEqual(macro.channelMap, { red: 2 });
  assert.strictEqual(macro.channelList[1].attribute, 'colorPreset');
});

test('a shutter closed at 0 is held open, and still runs as the strobe when it can', () => {
  const channels = {
    Dimmer: { capability: { type: 'Intensity' } },
    Shutter: {
      capabilities: [
        { dmxRange: [0, 9], type: 'ShutterStrobe', shutterEffect: 'Closed' },
        { dmxRange: [10, 19], type: 'ShutterStrobe', shutterEffect: 'Open' },
        { dmxRange: [20, 255], type: 'ShutterStrobe', shutterEffect: 'Strobe' },
      ],
    },
    Iris: { capabilities: [{ dmxRange: [0, 127], type: 'ShutterStrobe', shutterEffect: 'Closed' }, { dmxRange: [128, 255], type: 'ShutterStrobe', shutterEffect: 'Open' }] },
  };
  const mode = one(fixture(channels, { M: ['Dimmer', 'Shutter', 'Iris'] }));
  assert.deepStrictEqual(mode.channelMap, { dimmer: 0, strobe: 1 });
  assert.deepStrictEqual(mode.defaults, [{ offset: 1, value: 10 }, { offset: 2, value: 128 }]);
  assert.strictEqual(mode.channelList[2].attribute, 'shutterStrobe', 'a shutter that never flashes is not a strobe');
  assert.ok(warned(mode, /"Shutter" is held at 10, open/));
});

test('a dimmer the show does not drive is held at full', () => {
  const mode = one(fixture({
    Dimmer: { capability: { type: 'Intensity' } },
    'Dimmer 2': { capability: { type: 'Intensity' } },
    'Dimmer/Strobe': {
      capabilities: [
        { dmxRange: [0, 127], type: 'Intensity', brightnessStart: '0%', brightnessEnd: '100%' },
        { dmxRange: [128, 255], type: 'ShutterStrobe', shutterEffect: 'Strobe' },
      ],
    },
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
  }, { M: ['Dimmer', 'Dimmer 2', 'Dimmer/Strobe', 'Red'] }));
  assert.deepStrictEqual(mode.channelMap, { dimmer: 0, red: 3 });
  assert.deepStrictEqual(mode.defaults, [{ offset: 1, value: 255 }, { offset: 2, value: 127 }]);
  assert.ok(warned(mode, /"Dimmer 2" is held at 255, full/));
  assert.ok(warned(mode, /"Dimmer\/Strobe" does not strobe as the show expects/));
});

test('defaults are written in every byte of a wide channel', () => {
  const mode = one(fixture({
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
    Pan: { fineChannelAliases: ['Pan fine'], defaultValue: '50%', capability: { type: 'Pan', angleStart: '0deg', angleEnd: '540deg' } },
    Tilt: { fineChannelAliases: ['Tilt fine'], dmxValueResolution: '8bit', defaultValue: 128, capability: { type: 'Tilt' } },
  }, { M: ['Red', 'Pan', 'Pan fine', 'Tilt', 'Tilt fine'] }));
  assert.deepStrictEqual(mode.defaults, [
    { offset: 1, value: 127 }, { offset: 2, value: 255 }, // 50% of 65535
    { offset: 3, value: 128 }, // 128 of 255 is 0x8000: nothing in the fine byte
  ]);
  assert.deepStrictEqual(mode.channelList.map((c) => c.attribute), ['red', 'pan', 'panFine', 'tilt', 'tiltFine']);
});

test('whites split only when there are both, and colours the show does not mix are named', () => {
  const colour = (color) => ({ capability: { type: 'ColorIntensity', color } });
  const both = one(fixture({ WW: colour('Warm White'), CW: colour('Cold White'), R: colour('Red') }, { M: ['R', 'WW', 'CW'] }));
  assert.deepStrictEqual(both.channelMap, { red: 0, warmWhite: 1, coolWhite: 2 });
  const warm = one(fixture({ WW: colour('Warm White'), R: colour('Red') }, { M: ['R', 'WW'] }));
  assert.deepStrictEqual(warm.channelMap, { red: 0, white: 1 });

  const cmy = one(fixture({ R: colour('Red'), C: colour('Cyan'), L: colour('Lime') }, { M: ['R', 'C', 'L'] }));
  assert.deepStrictEqual(cmy.channelMap, { red: 0 });
  assert.deepStrictEqual(cmy.channelList.map((c) => c.attribute), ['red', 'cyan', 'lime']);
  assert.ok(warned(cmy, /Cyan and Lime are not driven/));
});

test('a key the file does not define is left at 0 and said so; null is an unused channel', () => {
  const mode = one(fixture({ Red: { capability: { type: 'ColorIntensity', color: 'Red' } } }, { M: ['Red', null, 'Nope'] }));
  assert.strictEqual(mode.channelCount, 3);
  assert.deepStrictEqual(mode.channelList.map((c) => [c.name, c.attribute]), [['Red', 'red'], ['Unused', 'noFunction'], ['Nope', 'unknown']]);
  assert.ok(warned(mode, /"Nope" is not a channel of the file/));
});

test('a mode that cannot be a profile is left out, and a file with none refuses', () => {
  const red = { Red: { capability: { type: 'ColorIntensity', color: 'Red' } } };
  const big = {
    name: 'Huge', matrix: { pixelCount: [200, 1, 1] }, templateChannels: RGB, availableChannels: red,
    modes: [
      { name: 'Small', channels: ['Red'] },
      { name: 'Every pixel', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelABC', channelOrder: 'perPixel', templateChannels: ['Red $pixelKey', 'Green $pixelKey', 'Blue $pixelKey'] }] },
    ],
  };
  const r = parseOfl(big, {});
  assert.deepStrictEqual(r.modes.map((m) => m.modeName), ['Small']);
  assert.match(r.warnings[0], /Every pixel is left out: it has more than 512 channels/);
  assert.strictEqual(r.manufacturer, 'Unknown');

  assert.throws(() => parseOfl({ ...big, modes: [big.modes[1]] }), (err) => err.status === 400 && /no mode of Huge can be used/.test(err.message));
  assert.throws(() => parseOfl({ name: 'No modes' }), (err) => err.status === 400 && /modes/.test(err.message));
  assert.throws(() => parseOfl([1, 2, 3]), (err) => err.status === 400);
});

test('pixel groups by position are read; by name are not run', () => {
  const r = parseOfl(fixture({}, {}, {
    matrix: {
      pixelCount: [6, 1, 1],
      pixelGroups: { Odd: { x: ['odd'] }, Right: { x: ['>=4'] }, Named: { name: ['^(a+)+$'] } },
    },
    templateChannels: RGB,
    modes: [{ name: 'Groups', channels: [{ insert: 'matrixChannels', repeatFor: ['Right', 'Odd', 'Named'], channelOrder: 'perPixel', templateChannels: ['Red $pixelKey'] }] }],
  }), {});
  const mode = r.modes[0];
  // Odd starts at pixel 1, Right at pixel 4: that is their order along the bar.
  // Where Named is is not known, so it goes last.
  assert.deepStrictEqual(mode.cells.map((c) => [c.name, c.channelMap]), [['Group Odd', { red: 1 }], ['Group Right', { red: 0 }], ['Group Named', { red: 2 }]]);
  assert.ok(warned(mode, /"Named" picks its pixels by name, which is not read, so where it sits along the fixture is not known/));
});

test('a pixel key with quotes in it cannot break the template', () => {
  const mode = one(fixture({}, {}, {
    matrix: { pixelKeys: [[['a"1', 'b\\2']]] },
    templateChannels: RGB,
    modes: [{ name: 'Two', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelABC', channelOrder: 'perPixel', templateChannels: ['Red $pixelKey', 'Blue $pixelKey'] }] }],
  }));
  assert.deepStrictEqual(mode.channelList.map((c) => c.name), ['Red a"1', 'Blue a"1', 'Red b\\2', 'Blue b\\2']);
  assert.strictEqual(mode.cells.length, 2);
});

test('a matrix too large to be a fixture is refused before it is built', () => {
  assert.throws(() => parseOfl(fixture({}, { M: [] }, { matrix: { pixelCount: [1024, 1024, 1024] } })),
    (err) => err.status === 400 && /more than 1024/.test(err.message));
});

test('a template channel switches to its own pixel\'s channel', () => {
  const mode = one(fixture({}, {}, {
    matrix: { pixelCount: [2, 1, 1] },
    templateChannels: {
      'Mode $pixelKey': {
        name: 'Mode of pixel $pixelKey',
        capabilities: [
          { dmxRange: [0, 127], type: 'NoFunction', switchChannels: { 'Red $pixelKey / Macro $pixelKey': 'Red $pixelKey' } },
          { dmxRange: [128, 255], type: 'Effect', switchChannels: { 'Red $pixelKey / Macro $pixelKey': 'Macro $pixelKey' } },
        ],
      },
      'Red $pixelKey': { capability: { type: 'ColorIntensity', color: 'Red' } },
      'Macro $pixelKey': { capability: { type: 'ColorPreset' } },
    },
    modes: [{ name: 'Pixels', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelABC', channelOrder: 'perPixel', templateChannels: ['Mode $pixelKey', 'Red $pixelKey / Macro $pixelKey'] }] }],
  }));
  assert.deepStrictEqual(mode.cells.map((c) => c.channelMap), [{ red: 1 }, { red: 3 }]);
  assert.deepStrictEqual(mode.channelList.map((c) => c.name), ['Mode of pixel 1', 'Red 1 / Macro 1', 'Mode of pixel 2', 'Red 2 / Macro 2']);
  assert.ok(warned(mode, /"Red 2 \/ Macro 2" is read as "Red 2": it changes with "Mode of pixel 2", which sits at 0/));
});

test('a long list of problems is cut short', () => {
  const channels = Array.from({ length: 40 }, (_, i) => `Missing ${i}`);
  const mode = one(fixture({ Red: { capability: { type: 'ColorIntensity', color: 'Red' } } }, { M: ['Red', ...channels] }));
  assert.strictEqual(mode.warnings.length, 12);
  assert.strictEqual(mode.warnings[11], '…and 29 more');
});
