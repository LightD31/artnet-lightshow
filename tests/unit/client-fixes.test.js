// Client pieces without a natural test home: the Disco gate dots and the
// sequence loads, bundled by esbuild with a socket that never connects.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

async function load() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { gateDots } from './public-src/components/AudioMeters.jsx';
        export { createSequenceSync } from './public-src/components/Sequence.jsx';
      `,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.js': 'jsx' },
    alias: { 'socket.io-client': path.join(ROOT, 'tests', 'helpers', 'fake-socket-io.js') },
    logLevel: 'silent',
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'client-fixes-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

test('a Disco gate dot is open only while its band is hit, not whenever it has a threshold', () => {
  // The audio frame's disco block: each band's power, the power that would hit, and whether it hit this frame.
  const disco = { level: [0.4, 0.2, 0.1], gate: [0.3, 0.25, 0.05], hit: [true, false, false], peakHit: false };
  assert.deepStrictEqual(ui.gateDots(disco), [true, false, false]);
  assert.deepStrictEqual(ui.gateDots({ ...disco, hit: [false, false, true] }), [false, false, true]);
  assert.deepStrictEqual(ui.gateDots(null), []);
});

/** A request double whose answers the test hands out, in any order. */
function server() {
  const calls = [];
  const request = (url, init = {}) => new Promise((resolve) => calls.push({ method: init.method || 'GET', url, body: init.body && JSON.parse(init.body), resolve }));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { calls, request, flush };
}

test('sequence loads: two overlapping edits keep both, and the page reloads only for revisions it did not cause', async () => {
  const { calls, request, flush } = server();
  const shown = [];
  const sync = ui.createSequenceSync(request, (s) => shown.push(s));
  const base = { id: 'q', lanes: [{ id: 'a', mute: false }, { id: 'b', mute: false }] };
  const muteA = { ...base, lanes: [{ id: 'a', mute: true }, { id: 'b', mute: false }] };
  const muteAB = { ...base, lanes: [{ id: 'a', mute: true }, { id: 'b', mute: true }] };

  sync.reload(1);
  calls[0].resolve({ ok: true, sequence: base });
  await flush();
  sync.commit(muteA);
  sync.reload(2); // the broadcast of the first edit, ahead of its answer
  sync.commit(muteAB);
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'PUT', 'PUT'], 'no reload while this page\'s edits are in flight');
  calls[1].resolve({ ok: true, status: { revision: 2 } });
  calls[2].resolve({ ok: true, status: { revision: 3 } });
  await flush();
  sync.reload(3);
  await flush();
  assert.strictEqual(calls.length, 3, 'revisions this page caused are not fetched again');
  assert.deepStrictEqual(shown.at(-1), muteAB);

  // Someone else's edit is fetched; an answer older than a local edit does not land.
  sync.reload(7);
  assert.strictEqual(calls.at(-1).method, 'GET');
  const stale = calls.at(-1);
  sync.commit(muteA);
  stale.resolve({ ok: true, sequence: base });
  calls.at(-1).resolve({ ok: true, status: { revision: 8 } });
  await flush();
  assert.deepStrictEqual(shown.at(-1), muteA, 'the GET sent before the edit is dropped');
});

test('sequence loads: of two GETs in flight only the latest lands, and a foreign revision seen during an edit is fetched after it', async () => {
  const { calls, request, flush } = server();
  const shown = [];
  const sync = ui.createSequenceSync(request, (s) => shown.push(s));
  sync.reload(1);
  sync.reload(2);
  calls[1].resolve({ ok: true, sequence: { id: 'new' } });
  calls[0].resolve({ ok: true, sequence: { id: 'old' } });
  await flush();
  assert.deepStrictEqual(shown, [{ id: 'new' }]);

  sync.commit({ id: 'mine' });
  sync.reload(9); // not this page's: its PUT answers with revision 3
  calls.at(-1).resolve({ ok: true, status: { revision: 3 } });
  await flush();
  assert.deepStrictEqual(calls.at(-1).method, 'GET', 'fetched once the edit has answered');
  calls.at(-1).resolve({ ok: true, sequence: { id: 'theirs' } });
  await flush();
  assert.deepStrictEqual(shown.at(-1), { id: 'theirs' });
});
