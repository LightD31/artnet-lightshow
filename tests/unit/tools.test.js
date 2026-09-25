// The programs the analysis needs besides Python (src/tools.ts): on PATH
// first, then in the analysis environment, whose scripts folder is on no PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptsDirs, envTool, onPath, ffmpeg, ffmpegCommand, _reset } from '../../src/tools.ts';

test('an environment keeps its programs beside its python — or, on Windows, in Scripts below it', () => {
  assert.deepEqual(scriptsDirs('/data/.venv/bin/python', 'linux'), ['/data/.venv/bin']);
  assert.deepEqual(scriptsDirs('C:\\data\\.venv\\Scripts\\python.exe', 'win32'),
    ['C:\\data\\.venv\\Scripts', 'C:\\data\\.venv\\Scripts\\Scripts']);
  assert.deepEqual(scriptsDirs('C:\\Python312\\python.exe', 'win32'), ['C:\\Python312', 'C:\\Python312\\Scripts']);
});

test('a program in the environment is found by name, with .exe on Windows', () => {
  const have = new Set(['/data/.venv/bin/deno', 'C:\\Python312\\Scripts\\yt-dlp.exe']);
  const exists = (f) => have.has(f);
  assert.equal(envTool('deno', { python: '/data/.venv/bin/python', platform: 'linux', exists }), '/data/.venv/bin/deno');
  assert.equal(envTool('yt-dlp', { python: '/data/.venv/bin/python', platform: 'linux', exists }), null);
  assert.equal(envTool('yt-dlp', { python: 'C:\\Python312\\python.exe', platform: 'win32', exists }),
    'C:\\Python312\\Scripts\\yt-dlp.exe');
  assert.equal(envTool('deno', { python: null, exists }), null, 'no usable interpreter, no environment');
  assert.equal(envTool('deno', { python: 'python3', platform: 'linux', exists: () => true }), null, 'a bare name is not a place');
});

test('a program on PATH is looked for as the shell would, PATHEXT and all', () => {
  const have = new Set(['/opt/ff/bin/ffmpeg', 'C:\\tools\\ffmpeg.EXE'.toLowerCase(), 'C:\\bin\\yt-dlp.cmd']);
  const exists = (f) => have.has(f) || have.has(f.toLowerCase());
  assert.equal(onPath('ffmpeg', { env: { PATH: '/usr/bin:/opt/ff/bin' }, platform: 'linux', exists }), '/opt/ff/bin/ffmpeg');
  assert.equal(onPath('ffmpeg', { env: { PATH: '/usr/bin' }, platform: 'linux', exists }), null);
  assert.equal(onPath('ffmpeg', { env: { Path: 'C:\\Windows;C:\\tools', PATHEXT: '.COM;.EXE' }, platform: 'win32', exists }),
    'C:\\tools\\ffmpeg.exe');
  assert.equal(onPath('yt-dlp', { env: { PATH: 'C:\\bin' }, platform: 'win32', exists }), 'C:\\bin\\yt-dlp.cmd',
    'the default PATHEXT without one');
});

test('ffmpeg: the one on PATH, else the analysis environment\'s, else none',
  { skip: process.platform === 'win32' && 'uses POSIX shell stand-ins' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-ffmpeg-'));
    const original = process.env.PATH;
    t.after(() => { process.env.PATH = original; _reset(); fs.rmSync(dir, { recursive: true, force: true }); });
    const script = (file, body) => { fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return file; };
    const envBinary = script(path.join(dir, 'ffmpeg-linux-x86_64-v7'), 'exit 0');
    // A python whose imageio-ffmpeg answers with the binary above.
    const python = script(path.join(dir, 'python'), `printf '%s' '${envBinary}'`);
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const onPath = path.join(dir, 'path');
    fs.mkdirSync(onPath);
    script(path.join(onPath, 'ffmpeg'), 'exit 0');

    process.env.PATH = onPath;
    _reset();
    assert.deepEqual(await ffmpeg({ python: () => python }), { command: 'ffmpeg', from: 'path' });

    process.env.PATH = empty;
    _reset();
    assert.deepEqual(await ffmpeg({ python: () => python }), { command: envBinary, from: 'environment' });
    assert.equal(await ffmpegCommand(), envBinary, 'remembered once found');

    _reset();
    assert.equal(await ffmpeg({ python: () => null }), null);
    assert.equal(await ffmpegCommand({ python: () => null }), 'ffmpeg', 'not finding one is not remembered: the bare name, to fail as before');
  });
