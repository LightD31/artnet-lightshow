// The rules every JSON file the server keeps follows (src/server/json-store.ts):
// no file is normal, a bad one is moved aside rather than lost, and a write
// never leaves half a file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { JsonStore } from '../../src/server/json-store.ts';

class Counter extends JsonStore {
  constructor(file, options = {}) {
    super(file, { tag: 'test', fallback: 'counting from zero', ...options });
    this.count = 0;
    this.defaulted = 0;
  }

  load() {
    const saved = this.readValid(z.object({ count: z.number().int() }).strict());
    if (saved) this.count = saved.count;
    return this;
  }

  useDefaults() {
    this.count = 0;
    this.defaulted++;
  }
}

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'nested', 'counter.json') };
}

const quietly = (t) => t.mock.method(console, 'warn', () => {});
const invalidIn = (dir) => fs.readdirSync(path.join(dir, 'nested')).filter((f) => f.includes('.invalid-'));

test('no file is normal: nothing is loaded, moved or said', (t) => {
  const { file } = place(t);
  const warn = quietly(t);
  const store = new Counter(file).load();
  assert.equal(store.count, 0);
  assert.equal(store.defaulted, 0);
  assert.equal(warn.mock.callCount(), 0);
});

test('a file written is read back, through the directory it needed', (t) => {
  const { file } = place(t);
  const store = new Counter(file);
  store.count = 7;
  store.writeJson({ count: store.count });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "count": 7\n}\n');
  assert.equal(new Counter(file).load().count, 7);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['counter.json'], 'no temporary file left behind');
});

test('a file that is not JSON is moved aside, and the defaults put back', (t) => {
  const { dir, file } = place(t);
  const warn = quietly(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ "count": 3,');
  const store = new Counter(file);
  store.count = 99;
  store.load();
  assert.equal(store.count, 0);
  assert.equal(store.defaulted, 1);
  assert.equal(fs.existsSync(file), false);
  const [aside] = invalidIn(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'nested', aside), 'utf8'), '{ "count": 3,', 'kept, to be recovered');
  assert.match(warn.mock.calls.map((c) => c.arguments[0]).join('\n'), /invalid JSON[\s\S]*counting from zero/);
});

test('a file the store does not accept is moved aside with what was wrong', (t) => {
  const { dir, file } = place(t);
  const warn = quietly(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ count: 1.5, extra: true }));
  assert.equal(new Counter(file).load().count, 0);
  assert.equal(invalidIn(dir).length, 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /count .*int/i);
});

test('a store can mend an older file before it is checked', (t) => {
  const { file } = place(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ n: 4 }));
  const store = new Counter(file);
  const saved = store.readValid(z.object({ count: z.number() }), (old) => ({ count: old.n }));
  assert.deepEqual(saved, { count: 4 });
});

test('a file that holds secrets is written 0600', { skip: process.platform === 'win32' }, (t) => {
  const { file } = place(t);
  new Counter(file, { mode: 0o600 }).writeJson({ count: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
