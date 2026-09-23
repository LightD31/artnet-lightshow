import test from 'node:test';
import assert from 'node:assert';
import { patchSchema, profileSchema, overrideSchema, deezerStateSchema, fixtureMessageSchema, fixtureRestoreSchema, showSchema, validate } from '../../src/server/validation.ts';

const ok = (schema, v) => { validate(schema, v, 't'); return true; };
const rejects = (schema, v) => assert.throws(() => validate(schema, v, 't'));

test('patch schema bounds the control ranges', () => {
  assert.ok(ok(patchSchema, { bpm: 120, masterDimmer: 255, colorA: 0 }));
  rejects(patchSchema, { bpm: 19 });
  rejects(patchSchema, { bpm: 301 });
  rejects(patchSchema, { masterDimmer: 256 });
  rejects(patchSchema, { colorA: -1 });
  rejects(patchSchema, { unknownField: 1 });      // .strict()
});

// A mistyped host used to reach dgram, fail DNS, and kill the
// process. Dotted-numeric strings are held to IPv4 rules so a typo is caught.
test('artnet host accepts addresses and hostnames, rejects mistyped IPs', () => {
  for (const host of ['2.255.255.255', '192.168.1.50', '10.0.0.1', 'artnet-node.local', 'node1']) {
    assert.ok(ok(patchSchema, { artnet: { host } }), host);
  }
  for (const host of ['2.255.255.256', '999.1.1.1', '1.2.3', '1.2.3.4.5', 'not a host!', '', 'http://x']) {
    rejects(patchSchema, { artnet: { host } });
  }
});

// "__proto__" as a profile id reassigned the registry's prototype.
test('reserved profile ids are rejected', () => {
  const good = { id: 'acme-par', name: 'PAR', channelCount: 4, channelMap: { red: 0 } };
  assert.ok(ok(profileSchema, good));
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    rejects(profileSchema, { ...good, id });
  }
});

test('fixture override clamps to byte range and requires enabled', () => {
  assert.ok(ok(overrideSchema, { enabled: true, r: 255, g: 0, b: 0 }));
  rejects(overrideSchema, { enabled: true, r: 256 });
  rejects(overrideSchema, { r: 1 });               // `enabled` is required
  const parsed = validate(overrideSchema, { enabled: true }, 't');
  assert.strictEqual(parsed.dim, 255, 'dim defaults to full');
  assert.strictEqual(parsed.blackout, false);
});

// channelCount is the fixture's DMX footprint: it decides where the next
// fixture may be patched. An offset past it writes into the neighbour.
test('a profile cannot map channels outside its own footprint', () => {
  const base = { id: 'acme-par', name: 'PAR', channelCount: 4 };
  assert.ok(ok(profileSchema, { ...base, channelMap: { red: 0, green: 1, blue: 3 } }));
  rejects(profileSchema, { ...base, channelMap: { red: 0, uv: 4 } });    // one past the end
  rejects(profileSchema, { ...base, channelMap: { red: 0, uv: 40 } });   // far past the end
});

// The extension's payload reaches state that is broadcast to every client, and
// feeds search queries and cache keys. Field types were coerced; sizes weren't.
test('deezer state bounds text fields and queue length', () => {
  assert.ok(ok(deezerStateSchema, {
    current: { name: 'Song', artist: 'Artist', isrc: 'GBxxx0000001', isPlaying: true },
    upcoming: [{ name: 'Next', artist: 'Artist' }],
  }));
  assert.ok(ok(deezerStateSchema, {}), 'an empty report is legal');
  rejects(deezerStateSchema, { current: { name: 'x'.repeat(1000) } });
  rejects(deezerStateSchema, { upcoming: new Array(500).fill({ name: 'a', artist: 'b' }) });
});

// An undo has to carry enough to put the fixture back exactly as it left —
// including the override, or a fixture deleted while overridden comes back
// reset to the pattern engine.
test('a fixture restore carries the whole fixture and where it was', () => {
  assert.ok(ok(fixtureRestoreSchema, {
    index: 2,
    fixture: { label: 'PAR 3', address: 25, universe: 1, profileId: 'cameo-root-par-6-12ch' },
  }));

  assert.ok(ok(fixtureRestoreSchema, {
    index: 0,
    fixture: {
      label: 'PAR 1', address: 1, profileId: 'cameo-root-par-6-12ch',
      override: { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 200, strobe: 0, blackout: false },
    },
  }));
});

// A show saved before universes has no universe field; the route falls back to
// the rig default, so the schema must let it through.
test('a fixture restore may omit the universe and the override', () => {
  assert.ok(ok(fixtureRestoreSchema, {
    index: 0,
    fixture: { label: 'PAR 1', address: 1, profileId: 'cameo-root-par-6-12ch' },
  }));
});

test('a fixture restore is bounded like every other patch write', () => {
  const fixture = { label: 'PAR 1', address: 1, profileId: 'cameo-root-par-6-12ch' };
  rejects(fixtureRestoreSchema, { index: -1, fixture });
  rejects(fixtureRestoreSchema, { index: 0, fixture: { ...fixture, address: 0 } });
  rejects(fixtureRestoreSchema, { index: 0, fixture: { ...fixture, address: 513 } });
  rejects(fixtureRestoreSchema, { index: 0, fixture: { ...fixture, universe: 32768 } });
  rejects(fixtureRestoreSchema, { index: 0, fixture: { ...fixture, surprise: 1 } });
  rejects(fixtureRestoreSchema, { fixture });                    // index required
  rejects(fixtureRestoreSchema, { index: 0 });                   // fixture required
});

// A palette id reaches a bank lookup that returns undefined for anything it
// does not know. Unlike a pattern id — which the engine can sensibly no-op on —
// a palette that quietly does nothing reads as the colour buttons being broken,
// so the schema names the looks it accepts.
test('patch schema accepts known palettes and refuses the rest', () => {
  assert.ok(ok(patchSchema, { palette: 'arctic' }));
  assert.ok(ok(patchSchema, { palette: 'arctic', paletteSize: 2 }));
  assert.ok(ok(patchSchema, { palette: null }));
  rejects(patchSchema, { palette: 'not-a-look' });
  rejects(patchSchema, { palette: 'arctic', paletteSize: 5 });
  rejects(patchSchema, { palette: 'arctic', paletteSize: 0 });
});

test('the auto-show intensity is bounded to a percentage', () => {
  assert.ok(ok(patchSchema, { autoIntensity: 0 }));
  assert.ok(ok(patchSchema, { autoIntensity: 100 }));
  rejects(patchSchema, { autoIntensity: -1 });
  rejects(patchSchema, { autoIntensity: 101 });
});

// The trim rides the fixture message rather than the override, so it has to be
// bounded there — and a show file has to be able to carry it home.
test('fixture max brightness is bounded wherever it can be set', () => {
  assert.ok(ok(fixtureMessageSchema, { id: 0, maxBrightness: 0 }));
  assert.ok(ok(fixtureMessageSchema, { id: 0, maxBrightness: 255 }));
  rejects(fixtureMessageSchema, { id: 0, maxBrightness: 256 });
  rejects(fixtureMessageSchema, { id: 0, maxBrightness: -1 });

  const fixture = { label: 'PAR', address: 1, profileId: 'p', maxBrightness: 128 };
  assert.ok(ok(fixtureRestoreSchema, { index: 0, fixture }));
  rejects(fixtureRestoreSchema, { index: 0, fixture: { ...fixture, maxBrightness: 300 } });

  assert.ok(ok(showSchema, { fixtures: [{ address: 1, maxBrightness: 200 }] }));
  rejects(showSchema, { fixtures: [{ address: 1, maxBrightness: 900 }] });
});

// A show saved before the trim existed has no maxBrightness at all, and must
// load at full rather than at nothing.
test('a show without a trim still validates', () => {
  assert.ok(ok(showSchema, { fixtures: [{ label: 'PAR', address: 1, profileId: 'p' }] }));
});

// ── LED bars: cells and geometry ─────────────────────────────────────────────

/** An eight-cell RGB bar with a master dimmer and strobe in front of the cells. */
function bar(over = {}) {
  const cells = Array.from({ length: 8 }, (_, i) => ({
    name: `Pixel ${i + 1}`,
    channelMap: { red: 2 + i * 3, green: 3 + i * 3, blue: 4 + i * 3 },
  }));
  return {
    id: 'acme-bar-8', name: 'Bar', channelCount: 26,
    channelMap: { dimmer: 0, strobe: 1 },
    channelList: [{ offset: 2, name: 'Pixel 1 Red', attribute: 'red', cell: 0 }],
    cells, ...over,
  };
}

test('a bar profile names each of its cells\' channels', () => {
  assert.ok(ok(profileSchema, bar()));
  const parsed = validate(profileSchema, bar(), 't');
  assert.strictEqual(parsed.cells.length, 8);
  assert.strictEqual(parsed.channelList[0].cell, 0, 'the cell a channel belongs to is kept for the monitor');
});

// Every one of these would put two looks on one byte, write outside the
// fixture, or call something a cell that makes no light.
test('a cell may not share a channel, leave the footprint or make no light', () => {
  const cells = bar().cells;
  rejects(profileSchema, bar({ cells: [cells[0], { channelMap: { red: 2, green: 30 } }] }));   // shares red@2
  rejects(profileSchema, bar({ cells: [cells[0], { channelMap: { red: 26 } }] }));             // past the footprint
  rejects(profileSchema, bar({ cells: [cells[0], { channelMap: { red: 0 } }] }));              // the fixture's dimmer
  rejects(profileSchema, bar({ cells: [cells[0], { channelMap: { dimmer: 8 } }] }));           // no light in it
  rejects(profileSchema, bar({ cells: [cells[0]] }), 'one cell is not a bar');
  rejects(profileSchema, bar({ cells: [cells[0], { channelMap: { red: 5 }, extra: 1 }] }), 'cells are strict');
});

test('a fixture\'s line on the stage is bounded wherever it is set', () => {
  const geometry = { length: 20, angle: -45 };
  assert.ok(ok(fixtureMessageSchema, { id: 1, geometry }));
  assert.ok(ok(fixtureMessageSchema, { id: 1, geometry: null }), 'null puts it back to the default');
  rejects(fixtureMessageSchema, { id: 1, geometry: { length: 0, angle: 0 } });
  rejects(fixtureMessageSchema, { id: 1, geometry: { length: 20, angle: 181 } });
  rejects(fixtureMessageSchema, { id: 1, geometry: { length: 20 } });
  assert.ok(ok(fixtureRestoreSchema, { index: 0, fixture: { label: 'Bar', address: 1, profileId: 'x', geometry } }));
  const show = validate(showSchema, { fixtures: [{ label: 'Bar', address: 1, geometry }] }, 't');
  assert.deepStrictEqual(show.fixtures[0].geometry, geometry, 'a show file keeps it');
});
