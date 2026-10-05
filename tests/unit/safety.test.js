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

const refused = (fn) => assert.throws(fn, (err) => err.status === 409 && err.message === 'photosensitivity acknowledgement required');

const FADE = validateSpec({ kind: 'ldj.FadeCycle', params: { cadence: 2 } });
// Faster than the threshold at this cadence, though the spec says otherwise.
const FAST = validateSpec({ kind: 'ldj.StrobeCycle', params: { cadence: 0.25 }, rapidFlash: false });

test('an ordinary effect plays unacknowledged; a strobe, a fast cadence and a spec that says so wait for the acknowledgement', (t) => {
  let saves = 0;
  holdSettings(t, () => { saves++; });
  assert.equal(safety.acknowledged(), false);
  safety.requireAcknowledged(FADE);
  // Light DJ's Flip as it ships plays; the same row asked to run at a quarter beat does not.
  const flip = presetById('ldj.Flip').spec;
  safety.requireAcknowledged(flip);
  refused(() => safety.requireAcknowledged(validateSpec({ ...flip, params: { ...flip.params, cadence: 0.25 }, rapidFlash: false })));
  refused(() => safety.requireAcknowledged(FAST));
  refused(() => safety.requireAcknowledged(validateSpec({ kind: 'strobe', params: {} })));
  refused(() => safety.requireAcknowledged({ ...FADE, rapidFlash: true }));
  refused(() => safety.requireAcknowledged(validateSpec({ kind: 'ldj.visualizer', params: {} })));

  safety.acknowledge();
  assert.equal(safety.acknowledged(), true);
  assert.equal(settings.get('safety.photosensitivityAcknowledged'), true, 'the setting the renderer reads');
  assert.equal(saves, 1, 'saved');
  safety.requireAcknowledged(FAST);
  safety.requireAcknowledged(validateSpec({ kind: 'strobe', params: {} }));

  // Given twice, it is the same acknowledgement: nothing more is written.
  safety.acknowledge();
  assert.equal(saves, 1);
});

test('the acknowledgement holds only once it is saved', (t) => {
  holdSettings(t, () => { throw new Error('disk full'); });
  assert.throws(() => safety.acknowledge(), /disk full/);
  assert.equal(safety.acknowledged(), false, 'not given when the file does not hold it');
  refused(() => safety.requireAcknowledged(FAST));
});

test('the status is the acknowledgement, Hue Dynamics\' flash limit and the latched strobe\'s cap', (t) => {
  holdSettings(t);
  assert.deepEqual(safety.status(), { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 });
  safety.acknowledge();
  assert.equal(safety.status().photosensitivityAcknowledged, true);
});
