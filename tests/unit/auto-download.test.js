// Downloads through a stand-in yt-dlp on PATH: what it is asked to do, and
// that two downloads started together cannot land in the same file.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AutoShow from '../../src/auto-show.js';
import * as ytdlp from '../../src/ytdlp.js';

// A yt-dlp that reports a given version, records its arguments, and writes
// `<template>.wav` where -o asked for it — which is all the real one is asked
// to do here.
function fakeYtDlp(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const log = path.join(dir, 'calls.log');
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
echo "$@" >> "${log}"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
sleep 0.2
printf 'RIFF' > "$(echo "$out" | sed 's/%(ext)s/wav/')"
`;
  fs.writeFileSync(path.join(dir, 'yt-dlp'), script, { mode: 0o755 });
  return { dir, log };
}

test('concurrent downloads get their own files and the JavaScript runtime',
  { skip: process.platform === 'win32' && 'uses a POSIX shell stand-in' }, async () => {
    const { dir, log } = fakeYtDlp('2025.11.12');
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    ytdlp._reset();
    const show = new AutoShow(() => {}, [{ name: 'Blackout' }], []);
    // Three prefetches starting in the same millisecond — rare with a slow
    // spawn in between, but nothing prevents it, and names built from the
    // clock then collide.
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const pending = [
        show._downloadAudio('Artist A - Song A', null, null),
        show._downloadAudio('Artist B - Song B', null, null),
        show._downloadAudio('Artist C - Song C', null, null),
      ];
      const files = await Promise.all(pending);
      assert.strictEqual(new Set(files).size, 3, 'three downloads, three files');
      for (const f of files) fs.rmSync(f, { force: true });

      const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.strictEqual(calls.length, 3);
      for (const call of calls) assert.match(call, /--js-runtimes node:\S+/);
    } finally {
      Date.now = realNow;
      process.env.PATH = originalPath;
      ytdlp._reset();
      show._worker.shutdown();
    }
  });

test('an older yt-dlp is not given an option it would refuse',
  { skip: process.platform === 'win32' && 'uses a POSIX shell stand-in' }, async () => {
    const { dir, log } = fakeYtDlp('2025.10.22');
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    ytdlp._reset();
    const show = new AutoShow(() => {}, [{ name: 'Blackout' }], []);
    try {
      const file = await show._downloadAudio('Artist - Song', null, null);
      fs.rmSync(file, { force: true });
      assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /--js-runtimes/);
    } finally {
      process.env.PATH = originalPath;
      ytdlp._reset();
      show._worker.shutdown();
    }
  });
