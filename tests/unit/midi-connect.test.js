// One implementation behind both ways of connecting a controller — the
// settings page's REST call and the main UI's socket message.

import test from 'node:test';
import assert from 'node:assert';

import { connectMidi } from '../../src/server/midi-connect.js';
import { settings } from '../../src/server/settings.ts';

function fakeMidi(opens = true) {
  const calls = [];
  return {
    calls, enabled: false,
    close() { calls.push('close'); },
    connect(input, output) { calls.push(['connect', input, output]); this.enabled = opens; return opens; },
    listPorts: () => ({ inputs: ['X-Touch'], outputs: ['X-Touch'] }),
  };
}

test('connecting closes the old ports, opens the new ones and remembers them', () => {
  const midi = fakeMidi();
  const saved = [];
  const update = settings.update;
  settings.update = (patch) => { saved.push(patch); return []; };
  try {
    const status = connectMidi(midi, { input: 'X-Touch', output: 'X-Touch' });
    assert.deepStrictEqual(midi.calls, ['close', ['connect', 'X-Touch', 'X-Touch']]);
    assert.deepStrictEqual(status, { ok: true, enabled: true, ports: { inputs: ['X-Touch'], outputs: ['X-Touch'] } });
    assert.deepStrictEqual(saved, [{ midi: { input: 'X-Touch', output: 'X-Touch' } }]);
  } finally { settings.update = update; }
});

test('blank ports disconnect, and are remembered as blank', () => {
  const midi = fakeMidi(false);
  const saved = [];
  const update = settings.update;
  settings.update = (patch) => { saved.push(patch); return []; };
  try {
    assert.strictEqual(connectMidi(midi, {}).ok, false);
    assert.deepStrictEqual(midi.calls[1], ['connect', null, null]);
    assert.deepStrictEqual(saved, [{ midi: { input: '', output: '' } }]);
  } finally { settings.update = update; }
});

test('a malformed request is refused before anything is closed', () => {
  const midi = fakeMidi();
  assert.throws(() => connectMidi(midi, { input: 42 }));
  assert.deepStrictEqual(midi.calls, []);
});
