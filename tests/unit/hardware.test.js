import test from 'node:test';
import assert from 'node:assert/strict';
import { hardwareOf, hardwareDecision, hardwareSettingsSchema, maximumFlashHz, stricterPolicy } from '../../src/shared/hardware.ts';

const PROFILE = { id: 'bar', name: 'Bar', channelCount: 12, channelMap: {},
  cells: [{ channelMap: { red: 0, green: 1, blue: 2, white: 3, amber: 4, uv: 5 } },
    { channelMap: { red: 6, green: 7, blue: 8, white: 9, amber: 10, uv: 11 } }] };
const FIXTURE = { output: { protocol: 'ddp' }, profileId: 'bar', productId: 'curtain' };
const SETTINGS = { technologies: { ddp: { maxFlashHz: 15 } }, products: {
  curtain: { name: 'Curtain', technology: 'ddp', maxFlashHz: 5, minTransitionMs: 100, evidence: 'Measured test', verifiedFlashHz: 5 },
} };

test('capabilities resolve technology, product and individual device limits', () => {
  const defaults = hardwareOf(FIXTURE, PROFILE);
  assert.equal(defaults.source, 'technology');
  assert.equal(defaults.maxFlashHz, 20);
  assert.equal(defaults.measured, false);
  const product = hardwareOf(FIXTURE, PROFILE, SETTINGS);
  assert.equal(product.maxFlashHz, 5);
  assert.equal(product.minTransitionMs, 100);
  assert.equal(product.source, 'product');
  assert.equal(product.measured, true);
  const device = hardwareOf({ ...FIXTURE, hardware: { maxFlashHz: 2 } }, PROFILE, SETTINGS);
  assert.equal(device.maxFlashHz, 2);
  assert.equal(device.minTransitionMs, 100);
  assert.equal(device.source, 'device');
  assert.equal(device.measured, false, 'a device override cannot borrow product measurements');
});

test('a product record cannot change another output technology', () => {
  const hue = hardwareOf({ ...FIXTURE, output: { protocol: 'hue' } }, PROFILE, SETTINGS);
  assert.equal(hue.technology, 'hue');
  assert.equal(hue.source, 'technology');
  assert.equal(hue.maxFlashHz, 5);
  assert.equal(hue.minTransitionMs, 40);
});

test('channels and pixel capability describe the fixture profile', () => {
  const caps = hardwareOf(FIXTURE, PROFILE);
  assert.deepEqual(caps.channels, ['r', 'g', 'b', 'w', 'a', 'uv']);
  assert.equal(caps.pixels, 2);
  assert.equal(caps.strobeHz, null);
  const par = hardwareOf({}, { ...PROFILE, cells: undefined, channelMap: { strobe: 0, red: 1 }, strobeHz: { min: 1, max: 18 } });
  assert.equal(par.pixels, 1);
  assert.deepEqual(par.channels, ['r']);
  assert.deepEqual(par.strobeHz, { min: 1, max: 18 });
});

test('rate and transition limits choose the more restrictive playback speed', () => {
  const caps = hardwareOf(FIXTURE, PROFILE, SETTINGS);
  assert.equal(maximumFlashHz({ maxFlashHz: 20, minTransitionMs: 100 }), 5);
  assert.deepEqual(hardwareDecision({ flashHz: 20 }, caps), { mode: 'slower', ratio: 0.25, limitHz: 5 });
  assert.equal(hardwareDecision({ flashHz: 2, transitionMs: 20 }, caps).ratio, 0.2);
  assert.equal(hardwareDecision({ flashHz: 2, transitionMs: 200 }, caps).mode, 'play');
});

test('hold and exclusion apply only when a fixture cannot meet the request', () => {
  const caps = hardwareOf({ ...FIXTURE, admission: 'hold' }, PROFILE, SETTINGS);
  assert.equal(hardwareDecision({ flashHz: 10 }, caps).mode, 'hold');
  assert.equal(hardwareDecision({ flashHz: 2 }, caps, 'exclude').mode, 'play');
  assert.equal(hardwareDecision({ flashHz: 10 }, caps, 'exclude').mode, 'exclude');
  assert.equal(stricterPolicy('max', 'hold'), 'hold');
  assert.equal(stricterPolicy('exclude', 'hold'), 'exclude');
});

test('partial measurements do not verify a higher configured flash rate', () => {
  const caps = hardwareOf(FIXTURE, PROFILE, { ...SETTINGS, products: { curtain: { ...SETTINGS.products.curtain, maxFlashHz: 20 } } });
  assert.equal(caps.verifiedFlashHz, 5);
  assert.equal(caps.measured, false);
});

test('hardware settings reject impossible values and unknown fields', () => {
  assert.deepEqual(hardwareSettingsSchema.parse(SETTINGS), SETTINGS);
  for (const technology of [{ maxFlashHz: 0 }, { minTransitionMs: -1 }, { unknown: 1 }, { verifiedFlashHz: Infinity }]) {
    assert.throws(() => hardwareSettingsSchema.parse({ technologies: { hue: technology }, products: {} }));
  }
  assert.throws(() => hardwareSettingsSchema.parse({ technologies: { zigbee: {} }, products: {} }));
});

test('missing RGB and pixel requirements obey the fixture policy', () => {
  const white = hardwareOf({ admission: 'exclude' }, { id: 'white', name: 'White', channelCount: 1, channelMap: { white: 0 } });
  assert.equal(hardwareDecision({ flashHz: 0, channels: ['r', 'g', 'b'] }, white).mode, 'exclude');
  assert.equal(hardwareDecision({ flashHz: 0, pixels: true }, white).mode, 'exclude');
});
