import test from 'node:test';
import assert from 'node:assert';
import JSZip from 'jszip';
import { parseGDTF } from '../../src/gdtf.ts';
import { inflateCapped } from '../../src/gdtf.ts';
import { profileSchema, validate } from '../../src/server/validation.ts';

function gdtf(xml) {
  const z = new JSZip();
  z.file('description.xml', xml);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const mode = (channels) =>
  `<GDTF><FixtureType Name='Test' Manufacturer='Acme'><DMXModes><DMXMode Name='M1'><DMXChannels>`
  + channels.map(([off, attr]) => `<DMXChannel Offset='${off}'><LogicalChannel Attribute='${attr}'/></DMXChannel>`).join('')
  + `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;

test('parses fixture identity and maps GDTF attributes to channels', async () => {
  const r = await parseGDTF(await gdtf(mode([[1, 'Dimmer'], [2, 'ColorAdd_R'], [3, 'ColorAdd_G'], [4, 'ColorAdd_B']])));
  assert.strictEqual(r.name, 'Test');
  assert.strictEqual(r.manufacturer, 'Acme');
  assert.strictEqual(r.modes.length, 1);
  assert.deepStrictEqual(r.modes[0].channelMap, { dimmer: 0, red: 1, green: 2, blue: 3 });
});

// channelCount is the DMX footprint, not the number of entries.
// A sparse mode reported 3 while occupying 20 channels, so the render loop
// cleared 3 and wrote 20 — the rest latched until master blackout.
test('channelCount is the address footprint, not the entry count', async () => {
  const contiguous = await parseGDTF(await gdtf(mode([[1, 'Dimmer'], [2, 'ColorAdd_R'], [3, 'ColorAdd_G']])));
  assert.strictEqual(contiguous.modes[0].channelCount, 3);

  const sparse = await parseGDTF(await gdtf(mode([[1, 'Dimmer'], [2, 'ColorAdd_R'], [20, 'ColorAdd_B']])));
  assert.strictEqual(sparse.modes[0].channelList.length, 3, 'three channel entries');
  assert.strictEqual(sparse.modes[0].channelCount, 20, 'but occupies 20 DMX channels');

  const offsetOnly = await parseGDTF(await gdtf(mode([[8, 'Dimmer']])));
  assert.strictEqual(offsetOnly.modes[0].channelCount, 8);
});

test('rejects archives without a usable description', async () => {
  const empty = new JSZip();
  empty.file('other.txt', 'x');
  await assert.rejects(parseGDTF(await empty.generateAsync({ type: 'nodebuffer' })), /description\.xml/);

  await assert.rejects(parseGDTF(await gdtf('<GDTF></GDTF>')), /FixtureType/);
});

// A small upload could expand to gigabytes of heap.
test('refuses a zip bomb before decompressing it', async () => {
  const buf = await gdtf('A'.repeat(64 * 1024 * 1024));
  assert.ok(buf.length < 1024 * 1024, 'compresses to well under a megabyte');
  await assert.rejects(parseGDTF(buf), /too large/);
});

// The declared size is the archive's own claim. The stream cap is what holds
// when a crafted archive understates it.
test('stops inflating at the limit whatever the archive declares', async () => {
  const zip = new JSZip();
  zip.file('description.xml', 'B'.repeat(4 * 1024 * 1024));
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const entry = loaded.file('description.xml');
  await assert.rejects(inflateCapped(entry, 64 * 1024), /too large/);
  assert.strictEqual((await inflateCapped(entry, 8 * 1024 * 1024)).length, 4 * 1024 * 1024);
});

// ── LED bars, 16-bit and virtual channels ────────────────────────────────────

const channel = ({ off, attr, geometry, brk, name }) => `<DMXChannel${brk ? ` DMXBreak='${brk}'` : ''}${off !== undefined ? ` Offset='${off}'` : ''}${geometry ? ` Geometry='${geometry}'` : ''}>`
  + `<LogicalChannel Attribute='${attr}'>${name ? `<ChannelFunction Name='${name}' Attribute='${attr}'/>` : ''}</LogicalChannel></DMXChannel>`;

const fixtureType = ({ geometries = '', channels, root = 'Base' }) =>
  `<GDTF><FixtureType Name='Bar' Manufacturer='Acme'><Geometries>${geometries}</Geometries>`
  + `<DMXModes><DMXMode Name='Pixel' Geometry='${root}'><DMXChannels>${channels.map(channel).join('')}</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;

test('a bar with a geometry per pixel imports as cells, in address order', async () => {
  const pixels = [2, 1, 3, 4];                    // declared out of order on purpose
  const geometries = `<Geometry Name='Base'>${pixels.map((n) => `<Geometry Name='Pixel ${n}'/>`).join('')}</Geometry>`;
  const channels = [
    { off: 1, attr: 'Dimmer', geometry: 'Base' },
    { off: 2, attr: 'Shutter1', geometry: 'Base' },
    ...pixels.flatMap((n) => [
      { off: 3 + (n - 1) * 3, attr: 'ColorAdd_R', geometry: `Pixel ${n}`, name: 'Red' },
      { off: 4 + (n - 1) * 3, attr: 'ColorAdd_G', geometry: `Pixel ${n}`, name: 'Green' },
      { off: 5 + (n - 1) * 3, attr: 'ColorAdd_B', geometry: `Pixel ${n}`, name: 'Blue' },
    ]),
  ];
  const [m] = (await parseGDTF(await gdtf(fixtureType({ geometries, channels })))).modes;
  assert.strictEqual(m.channelCount, 14);
  assert.deepStrictEqual(m.channelMap, { dimmer: 0, strobe: 1 }, 'the bar\'s own channels');
  assert.deepStrictEqual(m.cells.map((c) => c.name), ['Pixel 1', 'Pixel 2', 'Pixel 3', 'Pixel 4']);
  assert.deepStrictEqual(m.cells[2].channelMap, { red: 8, green: 9, blue: 10 });
  const cell3 = m.channelList.find((c) => c.offset === 8);
  assert.deepStrictEqual([cell3.name, cell3.cell], ['Pixel 3 Red', 2]);
  assert.strictEqual(m.warnings, undefined);
  // And it is a profile the server accepts as it stands.
  validate(profileSchema, { id: 'acme-bar', name: 'Bar', ...m }, 'profile');
});

test('a bar that places one pixel template by reference imports every copy', async () => {
  const geometries = `<Geometry Name='Base'>`
    + [1, 2, 3].map((n) => `<GeometryReference Name='Pixel ${n}' Geometry='Pixel'><Break DMXBreak='1' DMXOffset='${2 + (n - 1) * 4}'/></GeometryReference>`).join('')
    + `</Geometry><Geometry Name='Pixel'><Beam Name='Pixel Beam'/></Geometry>`;
  const channels = [
    { off: 1, attr: 'Dimmer', geometry: 'Base' },
    { off: 1, attr: 'ColorAdd_R', geometry: 'Pixel', brk: 'Overwrite' },
    { off: 2, attr: 'ColorAdd_G', geometry: 'Pixel', brk: 'Overwrite' },
    { off: 3, attr: 'ColorAdd_B', geometry: 'Pixel', brk: 'Overwrite' },
    { off: 4, attr: 'ColorAdd_W', geometry: 'Pixel Beam', brk: 'Overwrite' },
  ];
  const [m] = (await parseGDTF(await gdtf(fixtureType({ geometries, channels })))).modes;
  assert.strictEqual(m.channelCount, 13);
  assert.deepStrictEqual(m.cells.map((c) => c.channelMap), [
    { red: 1, green: 2, blue: 3, white: 4 },
    { red: 5, green: 6, blue: 7, white: 8 },
    { red: 9, green: 10, blue: 11, white: 12 },
  ]);
  assert.deepStrictEqual(m.cells.map((c) => c.name), ['Pixel 1', 'Pixel 2', 'Pixel 3']);
});

test('a 16-bit dimmer counts its fine byte, and a virtual channel is no channel', async () => {
  const channels = [
    { off: '1,2', attr: 'Dimmer', geometry: 'Base' },
    { attr: 'Dimmer', geometry: 'Pixel' },          // virtual: no Offset
    { off: 3, attr: 'ColorAdd_R', geometry: 'Base' },
  ];
  const [m] = (await parseGDTF(await gdtf(fixtureType({ geometries: `<Geometry Name='Base'/>`, channels })))).modes;
  assert.deepStrictEqual(m.channelMap, { dimmer: 0, dimmerFine: 1, red: 2 });
  assert.strictEqual(m.channelCount, 3);
  assert.deepStrictEqual(m.channelList.map((c) => c.attribute), ['dimmer', 'dimmerFine', 'red']);
  assert.strictEqual(m.cells, undefined, 'one light');
});

test('a lamp with warm and cool white dies drives both, and red-yellow is amber', async () => {
  const both = await parseGDTF(await gdtf(mode([[1, 'ColorAdd_R'], [2, 'ColorAdd_WW'], [3, 'ColorAdd_CW'], [4, 'ColorAdd_RY']])));
  assert.deepStrictEqual(both.modes[0].channelMap, { red: 0, warmWhite: 1, coolWhite: 2, amber: 3 });
  const one = await parseGDTF(await gdtf(mode([[1, 'ColorAdd_R'], [2, 'ColorAdd_CW']])));
  assert.deepStrictEqual(one.modes[0].channelMap, { red: 0, white: 1 }, 'a single white die is the white');
});

test('channels this rig cannot reach are left out and said so', async () => {
  const channels = [
    { off: 1, attr: 'ColorAdd_R', geometry: 'Base' },
    { off: 1, attr: 'ColorAdd_G', geometry: 'Base', brk: '2' },
    { off: 513, attr: 'ColorAdd_B', geometry: 'Base' },
  ];
  const [m] = (await parseGDTF(await gdtf(fixtureType({ geometries: `<Geometry Name='Base'/>`, channels })))).modes;
  assert.deepStrictEqual(m.channelMap, { red: 0 });
  assert.strictEqual(m.warnings.length, 2);
  assert.match(m.warnings[0], /DMX break 2/);
  assert.match(m.warnings[1], /past channel 512/);
});

// ── Shutters, strobes and values at rest ─────────────────────────────────────
// The engine writes 0 to what it does not drive, and a strobe channel only
// while strobing: a shutter closed at 0 would leave the fixture dark.

// A channel with its functions: [name, attribute, DMXFrom, Default?, [[set name, DMXFrom]…]?]
const withFunctions = ({ off, attr, initial, defaultValue, functions, geometry = 'Base' }) =>
  `<DMXChannel Offset='${off}' Geometry='${geometry}'`
  + `${initial ? ` InitialFunction='${geometry}_${attr}.${attr}.${initial}'` : ''}${defaultValue ? ` Default='${defaultValue}'` : ''}>`
  + `<LogicalChannel Attribute='${attr}'>`
  + functions.map(([name, fnAttr, from, def, sets = []]) => `<ChannelFunction Name='${name}' Attribute='${fnAttr}' DMXFrom='${from}'${def ? ` Default='${def}'` : ''}>`
    + sets.map(([setName, setFrom]) => `<ChannelSet Name='${setName}' DMXFrom='${setFrom}'/>`).join('')
    + '</ChannelFunction>').join('')
  + '</LogicalChannel></DMXChannel>';

const oneLight = (...channels) => `<GDTF><FixtureType Name='Head' Manufacturer='Acme'><Geometries><Geometry Name='Base'/></Geometries>`
  + `<DMXModes><DMXMode Name='M' Geometry='Base'><DMXChannels>${channels.join('')}</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;

const DIMMER = withFunctions({ off: 1, attr: 'Dimmer', functions: [['Dimmer', 'Dimmer', '0/1']] });
const RED = withFunctions({ off: 3, attr: 'ColorAdd_R', functions: [['Red', 'ColorAdd_R', '0/1']] });
const readOne = async (...channels) => (await parseGDTF(await gdtf(oneLight(...channels)))).modes[0];

test('a shutter closed at 0 is held open, and is still the strobe when it strobes as the show does', async () => {
  const shutter = withFunctions({
    off: 2, attr: 'Shutter1',
    functions: [['Closed', 'Shutter1', '0/1', '0/1'], ['Open', 'Shutter1', '32/1'], ['Strobe', 'Shutter1Strobe', '64/1']],
  });
  const m = await readOne(DIMMER, shutter, RED);
  assert.deepStrictEqual(m.channelMap, { dimmer: 0, strobe: 1, red: 2 });
  assert.deepStrictEqual(m.defaults, [{ offset: 1, value: 32 }], 'open between flashes');
  assert.deepStrictEqual(m.warnings, ['Shutter1 on channel 2 is held at 32, open, so the light is not shut']);
  validate(profileSchema, { id: 'acme-head', name: 'Head', ...m }, 'profile');
});

test('a shutter open at 0 that strobes across 128–250 is the strobe, with nothing held', async () => {
  const shutter = withFunctions({
    off: 2, attr: 'Shutter1',
    functions: [['Open', 'Shutter1', '0/1'], ['Strobe', 'Shutter1Strobe', '10/1']],
  });
  const m = await readOne(DIMMER, shutter, RED);
  assert.deepStrictEqual(m.channelMap, { dimmer: 0, strobe: 1, red: 2 });
  assert.strictEqual(m.defaults, undefined);
  assert.strictEqual(m.warnings, undefined);

  // One function named in sets, starting where GDTF 1.1 says it does.
  const named = withFunctions({
    off: 2, attr: 'Shutter1', initial: 'Shutter',
    functions: [['Shutter', 'Shutter1', '0/1', '20/1', [['Closed', '0/1'], ['Open', '20/1'], ['Strobe slow to fast', '40/1']]]],
  });
  const n = await readOne(DIMMER, named, RED);
  assert.strictEqual(n.channelMap.strobe, 1);
  assert.deepStrictEqual(n.defaults, [{ offset: 1, value: 20 }]);
  assert.strictEqual(n.warnings, undefined, 'its own default is open: nothing to say');
});

test('a strobe that is not open at rest, or does not strobe across the range, is left to the software strobe', async () => {
  const strobesAtZero = withFunctions({ off: 2, attr: 'Shutter1', functions: [['Strobe', 'Shutter1Strobe', '0/1']] });
  const a = await readOne(DIMMER, strobesAtZero, RED);
  assert.deepStrictEqual(a.channelMap, { dimmer: 0, red: 2 });
  assert.strictEqual(a.channelList[1].attribute, 'strobe', 'still labelled for the monitor');
  assert.deepStrictEqual(a.warnings, ['Shutter1 on channel 2 does not strobe as the show expects (open at rest, flashing from 128 to 250), so the show flashes this fixture itself']);

  const randomAbove = withFunctions({
    off: 2, attr: 'Shutter1',
    functions: [['Open', 'Shutter1', '0/1'], ['Strobe', 'Shutter1Strobe', '8/1'], ['Random', 'Shutter1StrobeRandom', '200/1']],
  });
  const b = await readOne(DIMMER, randomAbove, RED);
  assert.strictEqual(b.channelMap.strobe, undefined);
  assert.match(b.warnings[0], /does not strobe as the show expects/);

  const closedOnly = withFunctions({
    off: 2, attr: 'Shutter1',
    functions: [['Closed', 'Shutter1', '0/1'], ['Pulse', 'Shutter1StrobeRandom', '128/1']],
  });
  const c = await readOne(DIMMER, closedOnly, RED);
  assert.strictEqual(c.defaults, undefined);
  assert.match(c.warnings.at(-1), /Shutter1 on channel 2 shuts the light at rest and has no open value/);
});

test('an undriven dimmer is held at full, and other channels at their defaults, 16-bit too', async () => {
  const second = withFunctions({ off: 2, attr: 'Dimmer', functions: [['Dimmer', 'Dimmer', '0/1']] });
  const pan = withFunctions({ off: '4,5', attr: 'Pan', functions: [['Pan', 'Pan', '0/2', '32767/2']] });
  const macro = withFunctions({ off: 6, attr: 'ColorMacro1', defaultValue: '0/1', functions: [['Off', 'NoFeature', '0/1'], ['Macro', 'ColorMacro1', '8/1']] });
  const m = await readOne(DIMMER, second, RED, pan, macro);
  assert.deepStrictEqual(m.channelMap, { dimmer: 0, red: 2, pan: 3, macro: 5 });
  assert.deepStrictEqual(m.defaults, [{ offset: 1, value: 255 }, { offset: 3, value: 127 }, { offset: 4, value: 255 }]);
  assert.deepStrictEqual(m.warnings, ['Dimmer on channel 2 is held at 255, full: the show does not drive it']);
});

test('a bar\'s shutter in every cell is held open, said once for all of them', async () => {
  const geometries = `<Geometry Name='Base'>${[1, 2, 3].map((n) => `<Geometry Name='Pixel ${n}'/>`).join('')}</Geometry>`;
  const xml = `<GDTF><FixtureType Name='Bar' Manufacturer='Acme'><Geometries>${geometries}</Geometries><DMXModes><DMXMode Name='Pixel' Geometry='Base'><DMXChannels>`
    + [1, 2, 3].map((n) => withFunctions({ off: 1 + (n - 1) * 2, attr: 'ColorAdd_R', geometry: `Pixel ${n}`, functions: [['Red', 'ColorAdd_R', '0/1']] })
      + withFunctions({ off: 2 + (n - 1) * 2, attr: 'Shutter1', geometry: `Pixel ${n}`, functions: [['Closed', 'Shutter1', '0/1'], ['Open', 'Shutter1', '16/1']] })).join('')
    + '</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>';
  const [m] = (await parseGDTF(await gdtf(xml))).modes;
  assert.strictEqual(m.cells.length, 3);
  assert.strictEqual(m.channelList[1].attribute, 'shutter', 'a shutter that never flashes is not a strobe');
  assert.deepStrictEqual(m.defaults, [{ offset: 1, value: 16 }, { offset: 3, value: 16 }, { offset: 5, value: 16 }]);
  assert.deepStrictEqual(m.warnings, ['Shutter1 on channels 2, 4 and 6 is held at 16, open, so the light is not shut']);
  validate(profileSchema, { id: 'acme-bar', name: 'Bar', ...m }, 'profile');
});
