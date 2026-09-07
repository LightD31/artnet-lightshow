'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { parseGDTF } = require('../../src/gdtf');

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

// AUDIT.md M3: channelCount is the DMX footprint, not the number of entries.
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

// AUDIT.md M8: a small upload could expand to gigabytes of heap.
test('refuses a zip bomb before decompressing it', async () => {
  const buf = await gdtf('A'.repeat(64 * 1024 * 1024));
  assert.ok(buf.length < 1024 * 1024, 'compresses to well under a megabyte');
  await assert.rejects(parseGDTF(buf), /too large/);
});
