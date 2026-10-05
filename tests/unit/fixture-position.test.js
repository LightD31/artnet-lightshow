import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSockets } from '../../src/server/sockets.ts';
import { state } from '../../src/server/state.ts';
import { showStore, snapshotShow, applyShow } from '../../src/server/show-store.ts';

// Exercise the socket handlers without opening a connection or saving a show.
function fixtureSocket() {
  let connect;
  const handlers = new Map();
  const errors = [];
  const io = { on(event, fn) { if (event === 'connection') connect = fn; }, emit() {} };
  attachSockets(io, {
    midi: { onLearn() {}, enabled: false, listPorts: () => [] },
    integrations: { broadcast() {}, publisher: {} },
  });
  connect({
    id: 'fixture-position-test', handshake: { auth: {} }, join() {},
    on(event, fn) { handlers.set(event, fn); },
    emit(event, payload) { if (event === 'error-msg') errors.push(payload); },
  });
  return { send: (payload) => handlers.get('fixture')(payload), errors };
}

test('moving a fixture retains its height through the socket and a saved show', (t) => {
  const before = { fixtures: state.fixtures, next: state.nextFixtureId, save: showStore.scheduleSave };
  showStore.scheduleSave = () => {};
  state.fixtures = [{
    id: 4, label: 'Raised par', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch',
    maxBrightness: 255, override: null, position: { x: 20, y: 30, height: 80 },
  }];
  t.after(() => {
    state.fixtures = before.fixtures;
    state.nextFixtureId = before.next;
    showStore.scheduleSave = before.save;
  });
  const socket = fixtureSocket();
  // The stage plot and inspector send only x and y when a fixture moves.
  socket.send({ id: 4, position: { x: 35, y: 45 } });
  assert.deepEqual(socket.errors, []);
  assert.deepEqual(state.fixtures[0].position, { x: 35, y: 45, height: 80 });
  applyShow(JSON.parse(JSON.stringify(snapshotShow())));
  assert.deepEqual(state.fixtures[0].position, { x: 35, y: 45, height: 80 });

  socket.send({ id: 4, position: { x: 35, y: 45, height: 0 } });
  assert.equal(state.fixtures[0].position.height, 0, 'an explicit floor height replaces the old height');
  socket.send({ id: 4, position: { x: 40, y: 50 } });
  assert.equal(state.fixtures[0].position.height, 0, 'the floor is not treated as an absent height');
  socket.send({ id: 4, position: { x: 40, y: 50, height: 101 } });
  assert.equal(socket.errors.length, 1, 'invalid heights are rejected before the position changes');
  assert.equal(state.fixtures[0].position.height, 0);

  socket.send({ id: 4, position: null });
  assert.equal(state.fixtures[0].position, null, 'reset place clears the height with the position');
  socket.send({ id: 4, position: { x: 10, y: 15 } });
  assert.deepEqual(state.fixtures[0].position, { x: 10, y: 15 }, 'a fresh position keeps the mid-room default');
});
