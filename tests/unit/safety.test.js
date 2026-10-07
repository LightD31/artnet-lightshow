// The photosensitivity gate (src/server/safety.ts): one check for every effect
// that flashes faster than the photosensitivity threshold, and the
// acknowledgement that opens it, given once and kept only once it is saved.

import test from 'node:test';
import assert from 'node:assert/strict';

import { safety } from '../../src/server/safety.ts';
import { settings } from '../../src/server/settings.ts';
// The entry point registers every kind before a spec is validated.
import '../../src/shared/effects/index.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { presetById } from '../../src/shared/effects/index.ts';

/**
 * The settings as they are, unacknowledged, given back after the test. `save`
 * stands in for the write: nothing reaches the checkout's settings.json.
 */
function holdSettings(t, save = () => {}) {
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  settings.save = save;
  t.after(() => {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
  });
}

const refused = (fn) => assert.throws(fn, (err) => err.status === 409);

const FADE = validateSpec({ kind: 'ldj.FadeCycle', params: { cadence: 2 } });
// Faster than the threshold at this cadence, though the spec says otherwise.
const FAST = validateSpec({ kind: 'ldj.StrobeCycle', params: { cadence: 0.25 }, rapidFlash: false });

test('ordinary effects run without acknowledgement', (t) => {
  holdSettings(t);
  assert.equal(safety.acknowledged(), false);
  safety.requireAcknowledged(FADE);
  safety.requireAcknowledged(presetById('ldj.Flip').spec);
});

const flip = presetById('ldj.Flip').spec;
for (const [name, spec] of [
  ['fast Flip', validateSpec({ ...flip, params: { ...flip.params, cadence: 0.25 }, rapidFlash: false })],
  ['fast StrobeCycle', FAST],
  ['strobe', validateSpec({ kind: 'strobe', params: {} })],
  ['explicit rapid flag', { ...FADE, rapidFlash: true }],
  ['visualizer', validateSpec({ kind: 'ldj.visualizer', params: {} })],
]) {
  test(`${name} requires acknowledgement`, (t) => {
    holdSettings(t);
    refused(() => safety.requireAcknowledged(spec));
    safety.acknowledge();
    safety.requireAcknowledged(spec);
  });
}

test('acknowledgement is persisted once', (t) => {
  let saves = 0;
  holdSettings(t, () => { saves++; });
  safety.acknowledge();
  assert.equal(safety.acknowledged(), true);
  assert.equal(settings.get('safety.photosensitivityAcknowledged'), true);
  assert.equal(saves, 1);
  safety.acknowledge();
  assert.equal(saves, 1);
});

test('the acknowledgement holds only once it is saved', (t) => {
  const failure = new Error('write failed');
  holdSettings(t, () => { throw failure; });
  assert.throws(() => safety.acknowledge(), (err) => err === failure);
  assert.equal(safety.acknowledged(), false, 'not given when the file does not hold it');
  refused(() => safety.requireAcknowledged(FAST));
});

test('safety status exposes the acknowledgement and flash limits', (t) => {
  holdSettings(t);
  assert.deepEqual(safety.status(), { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 });
  safety.acknowledge();
  assert.equal(safety.status().photosensitivityAcknowledged, true);
});
