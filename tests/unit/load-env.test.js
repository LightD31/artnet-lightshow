// The .env loader that replaced the dotenv package: Node's own parser, the
// environment winning over the file, and no file being normal.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../../src/load-env.ts';

test('a .env is read into the environment, and what is already set wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# a comment',
    'LOAD_ENV_TEST_NEW=from the file',
    'LOAD_ENV_TEST_SET=from the file',
    'LOAD_ENV_TEST_QUOTED="with # inside"',
    '',
  ].join('\n'));
  process.env.LOAD_ENV_TEST_SET = 'from the environment';
  try {
    assert.equal(loadEnv(file), true);
    assert.equal(process.env.LOAD_ENV_TEST_NEW, 'from the file');
    assert.equal(process.env.LOAD_ENV_TEST_SET, 'from the environment');
    assert.equal(process.env.LOAD_ENV_TEST_QUOTED, 'with # inside');
  } finally {
    for (const k of ['LOAD_ENV_TEST_NEW', 'LOAD_ENV_TEST_SET', 'LOAD_ENV_TEST_QUOTED']) delete process.env[k];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no .env is not an error', () => {
  assert.equal(loadEnv(path.join(os.tmpdir(), 'no-such-dir-for-load-env', '.env')), false);
});
