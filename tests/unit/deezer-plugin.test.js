// Deezer as an optional plugin (src/deezer.ts): d-fi-core is not loaded until
// Deezer is used, the server can tell whether it can decrypt Deezer's audio
// (OpenSSL's legacy provider, turned on only when an ARL is set), and an ARL
// it cannot use yet is reported as waiting on a restart. Each in a Node of its
// own, since what is loaded and which OpenSSL providers are on is per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');

function node(script, { flags = [], env = {} } = {}) {
  return execFileSync(process.execPath, [...flags, '--input-type=module', '-e', script], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8',
  }).trim().split('\n').at(-1);
}

test('the legacy provider is what decrypting Deezer\'s audio needs', () => {
  const probe = "const d = await import('./src/deezer.ts'); console.log(JSON.stringify([d.canDecrypt(), d.isAvailable()]));";
  assert.deepEqual(JSON.parse(node(probe)), [false, false], 'a server started as npm start starts it without an ARL');
  assert.deepEqual(JSON.parse(node(probe, { flags: ['--openssl-legacy-provider'] })), [true, false],
    'with the provider it can decrypt — and is still not available until signed in');
});

test('d-fi-core is not loaded until Deezer is used', () => {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context); } });
    const d = await import('./src/deezer.ts');
    d.canDecrypt(); d.isAvailable();
    const before = seen.includes('d-fi-core');
    await d.init('').catch(() => {});
    console.log(JSON.stringify([before, seen.includes('d-fi-core')]));
  `;
  assert.deepEqual(JSON.parse(node(script)), [false, false], 'not even an empty ARL loads it');
});

test('an ARL the server cannot use yet waits on a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deezer-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ deezer: { arl: 'an-arl' } }));
  const script = `
    const { createApplier } = await import('./src/server/apply.ts');
    const d = await import('./src/deezer.ts');
    const applier = createApplier({ deezer: { init: async () => {}, canDecrypt: d.canDecrypt } });
    console.log(JSON.stringify(applier.pendingRestart()));
  `;
  const env = { LIGHTSHOW_CONFIG_DIR: dir, LIGHTSHOW_CACHE_DIR: path.join(dir, 'cache') };
  assert.deepEqual(JSON.parse(node(script, { env })), ['deezer.arl']);
  assert.deepEqual(JSON.parse(node(script, { env, flags: ['--openssl-legacy-provider'] })), [], 'started with the provider, nothing waits');
});
