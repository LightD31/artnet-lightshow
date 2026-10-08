import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDriver, driverOf, startShow, transportButtons } from '../../public-src/transport-model.js';
import { resolveRoute, VIEWS, viewShortcut } from '../../public-src/views.js';

test('legacy bookmarks retain their instrument', () => {
  for (const [hash, expected] of [['#manual', 'effects'], ['#timeline', 'auto/timeline'], ['#matrix', 'perform/matrix'], ['#rig/outputs', 'rig/outputs']]) {
    assert.equal(resolveRoute(hash).canonical, expected);
  }
  assert.equal(resolveRoute('#unknown'), null);
  assert.equal(resolveRoute(''), null);
});

test('digit shortcuts follow the nine views and leave typing alone', () => {
  assert.deepEqual(VIEWS.map((v) => v.id), ['perform', 'effects', 'auto', 'sequence', 'stage', 'rig', 'sources', 'settings', 'preflight']);
  for (let i = 1; i <= 9; i++) {
    assert.equal(viewShortcut({ key: String(i) }).id, VIEWS[i - 1].id);
    for (const patch of [{ repeat: true }, { ctrlKey: true }, { shiftKey: true }, { defaultPrevented: true }, { target: { tagName: 'INPUT' } }, { target: { isContentEditable: true } }]) {
      assert.equal(viewShortcut({ key: String(i), ...patch }), null);
    }
  }
});

test('the shared transport plays and freezes a look without a sequence', () => {
  assert.equal(driverOf({ running: false }), 'look');
  assert.deepEqual(transportButtons('look', { running: false })[0].request, { set: { running: true } });
  assert.deepEqual(transportButtons('look', { running: true })[0].request, { set: { running: false } });
});

test('sequence selection preserves the generated show underneath it', () => {
  assert.deepEqual(chooseDriver('sequence:set', { showOn: true }), [{ path: '/api/sequence', method: 'PUT', body: { id: 'set' } }]);
  assert.equal(driverOf({ sequence: { loaded: { id: 'set' } }, showOn: true }), 'sequence');
});

test('returning to the look releases both sequence and automatic control', () => {
  assert.deepEqual(chooseDriver('look', { sequence: { loaded: { id: 'set' } }, showOn: true }), [
    { path: '/api/sequence', method: 'DELETE' }, { path: '/api/auto/stop', method: 'POST' },
  ]);
  assert.deepEqual(chooseDriver('auto', { sequence: { loaded: { id: 'set' } } }), [{ path: '/api/sequence', method: 'DELETE' }]);
});

test('show playback honours the server-selected source and ready analysis', () => {
  for (const source of ['spotify', 'deezer', 'nowplaying', 'prolink']) {
    assert.deepEqual(startShow({ autoSource: 'auto', activeSource: source }), {
      path: `/api/auto/analyze-${source}`, method: 'POST', body: { start: true },
    });
  }
  assert.equal(startShow({ autoSource: 'hybrid', activeSource: 'prolink' }).path, '/api/auto/analyze-spotify');
  assert.equal(startShow({ autoSource: 'spotify', autoShow: { status: 'ready' } }).path, '/api/auto/start');
  assert.equal(startShow({ autoSource: 'live' }).path, '/api/auto/start');
});

test('busy shows expose cancellation and cannot start twice', () => {
  const buttons = transportButtons('auto', { autoShow: { status: 'analyzing', startPending: true } });
  assert.equal(buttons.find((b) => b.id === 'play').enabled, false);
  assert.deepEqual(buttons.find((b) => b.id === 'cancel').request, { path: '/api/auto/cancel', method: 'POST' });
});

test('sequence looping keeps its saved bounds', () => {
  const buttons = transportButtons('sequence', { sequence: { loaded: { id: 'set' }, playing: true, loop: { on: true, startBeat: 4, endBeat: 12 } } });
  assert.equal(buttons[0].id, 'pause');
  assert.deepEqual(buttons.find((b) => b.id === 'loop').request.body, { on: false, startBeat: 4, endBeat: 12 });
  assert.ok(transportButtons('sequence', {}).every((b) => !b.enabled));
});
