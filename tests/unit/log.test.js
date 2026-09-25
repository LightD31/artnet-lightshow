// The server's log (src/server/log.ts): what the log view keeps, how a
// message's tag becomes its component, a file that rotates, the last run read
// back after a restart, and the console taken over.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LogBuffer, RotatingFile, splitComponent, entryOf, prettyLine, readTail, buffer, logger, startLogging, releaseConsole,
} from '../../src/server/log.ts';

const at = (level, msg, component = null) => ({ time: 1000, level, component, msg });

test('the buffer keeps the last entries, numbered, and filters by level', () => {
  const b = new LogBuffer(3);
  for (const [level, msg] of [['info', 'a'], ['warn', 'b'], ['debug', 'c'], ['error', 'd']]) b.push(at(level, msg));
  assert.equal(b.last, 4);
  assert.deepEqual(b.since().map((e) => e.msg), ['b', 'c', 'd'], 'the oldest dropped');
  assert.deepEqual(b.since(2).map((e) => e.msg), ['c', 'd'], 'only what came after');
  assert.deepEqual(b.since(0, { level: 'warn' }).map((e) => e.msg), ['b', 'd']);
  assert.deepEqual(b.since(0, { limit: 1 }).map((e) => e.msg), ['d'], 'the latest, when limited');
});

test('a message\'s [tag] is its component; the rest is the message', () => {
  assert.deepEqual(splitComponent('[show] moved it aside'), { component: 'show', msg: 'moved it aside' });
  assert.deepEqual(splitComponent('\n[settings] x'), { component: 'settings', msg: '\nx' });
  assert.deepEqual(splitComponent('GDTF parse error: bad'), { component: null, msg: 'GDTF parse error: bad' });
  assert.deepEqual(splitComponent('[not closed'), { component: null, msg: '[not closed' });
});

test('a pino record becomes an entry, with its other fields as data', () => {
  assert.deepEqual(entryOf({ level: 40, time: 5, msg: 'late', component: 'engine', frames: 3, pid: 1 }),
    { time: 5, level: 'warn', component: 'engine', msg: 'late', data: { frames: 3 } });
  assert.equal(entryOf({ level: 99, msg: 'x' }), null);
  assert.equal(entryOf('not a record'), null);
});

test('a line for the terminal: the time, the level unless info, the component', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  assert.equal(prettyLine({ time: t, level: 'info', component: 'hue', msg: 'paired' }), '09:05:07 [hue] paired\n');
  assert.equal(prettyLine({ time: t, level: 'warn', component: null, msg: 'hm' }), '09:05:07 WARN hm\n');
  assert.equal(prettyLine({ time: t, level: 'info', component: null, msg: '\n  banner' }), '\n09:05:07   banner\n',
    'a blank line before the banner stays before it');
  assert.ok(prettyLine({ time: t, level: 'error', component: null, msg: 'x' }, { colour: true }).includes('\u001b[31mERROR'));
});

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the file rotates past its size, keeping so many old ones', (t) => {
  const dir = tmp(t);
  const file = new RotatingFile(path.join(dir, 'logs', 'lightshow.log'), { maxBytes: 100, keep: 2 });
  for (let i = 0; i < 12; i++) file.write(`${JSON.stringify({ n: i, pad: 'x'.repeat(20) })}\n`);
  file.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')).sort(), ['lightshow.1.log', 'lightshow.2.log', 'lightshow.log']);
  for (const f of fs.readdirSync(path.join(dir, 'logs'))) {
    assert.ok(fs.statSync(path.join(dir, 'logs', f)).size <= 100, `${f} under the limit`);
  }
  const newest = fs.readFileSync(path.join(dir, 'logs', 'lightshow.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).n);
  assert.equal(newest.at(-1), 11, 'the latest line is in the current file');
});

test('the last run\'s tail is read back, skipping what is not a record', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'lightshow.log');
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ level: 30, time: i, msg: `line ${i}` }));
  lines.splice(100, 0, 'not json');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = readTail(file, 50);
  assert.equal(tail.length, 50);
  assert.equal(tail.at(-1).msg, 'line 299');
  assert.deepEqual(readTail(path.join(dir, 'missing.log')), []);
});

test('the server\'s log: the console taken over, tags as components, the file and the tail', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'lightshow.log'), `${JSON.stringify({ level: 50, time: 1, msg: 'before the crash', component: 'engine' })}\n`);
  const before = buffer.last;
  startLogging({ dir, terminal: 'none' });
  t.after(releaseConsole);
  console.warn('[show] %s is odd', 'this');
  console.log('no tag');
  logger('supervisor').info({ restarts: 1 }, 'back up');
  releaseConsole();

  const entries = buffer.since(before);
  assert.deepEqual(entries.map((e) => [e.level, e.component, e.msg, !!e.previous]), [
    ['error', 'engine', 'before the crash', true],
    ['warn', 'show', 'this is odd', false],
    ['info', null, 'no tag', false],
    ['info', 'supervisor', 'back up', false],
  ]);
  assert.deepEqual(entries[3].data, { restarts: 1 });
  const written = fs.readFileSync(path.join(dir, 'lightshow.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(written.slice(1).map((r) => r.msg), ['this is odd', 'no tag', 'back up'], 'appended after the last run');
});
