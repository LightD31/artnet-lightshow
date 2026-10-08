// One implementation behind both ways of connecting a controller — the
// settings page's REST call and the main UI's socket message.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { connectMidi } from '../../src/server/midi-connect.ts';
import { settings } from '../../src/server/settings.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { createPublisher } from '../../src/server/protocol.ts';

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

// ── Over a socket: the Settings picker asks for the ports again ─────────────

test('asking for the ports again tells every page, only when the list changed', async () => {
  let present = { inputs: ['AG06'], outputs: ['AG06'] };
  let cached = present;
  const midi = { onLearn() {}, enabled: false, listPorts: () => cached, refreshPorts: () => (cached = present) };
  let broadcasts = 0;
  const server = http.createServer();
  const io = new Server(server);
  attachSockets(io, { midi, integrations: { broadcast: () => { broadcasts++; }, publisher: createPublisher(io) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], forceNew: true });
  const settle = () => new Promise((r) => setTimeout(r, 80));
  try {
    await new Promise((r) => socket.once('connect', r));
    socket.emit('midi-ports');
    await settle();
    assert.strictEqual(broadcasts, 0, 'the same ports: nothing to tell');

    present = { inputs: ['AG06', 'X-Touch'], outputs: ['AG06', 'X-Touch'] };   // switched on
    socket.emit('midi-ports');
    await settle();
    assert.strictEqual(broadcasts, 1, 'a controller switched on');
    assert.deepStrictEqual(midi.listPorts(), present, 'and the broadcast carries it');
  } finally {
    socket.close();
    io.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
