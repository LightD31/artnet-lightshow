// Where the server keeps what it writes (src/server/config-dir.ts): the
// checkout by default, a data directory of its own when the packaged build
// names one, and each part movable on its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appDir, dataDir, configDir, configFile, cacheDir, logDir, venvDir, venvPython,
} from '../../src/server/config-dir.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const VARS = ['LIGHTSHOW_DATA_DIR', 'LIGHTSHOW_CONFIG_DIR', 'LIGHTSHOW_CACHE_DIR', 'LIGHTSHOW_LOG_DIR'];

function withEnv(t, env) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('in a checkout, everything is where it always was', (t) => {
  withEnv(t, {});
  assert.equal(appDir(), ROOT);
  assert.equal(dataDir(), ROOT);
  assert.equal(configDir(), path.join(ROOT, 'config'));
  assert.equal(configFile('settings.json'), path.join(ROOT, 'config', 'settings.json'));
  assert.equal(cacheDir(), path.join(ROOT, 'cache'));
  assert.equal(logDir(), path.join(ROOT, 'logs'));
  assert.equal(venvDir(), path.join(ROOT, '.venv'));
});

test('a data directory takes the config, the cache, the logs and the environment, not the app', (t) => {
  const data = path.resolve('/srv/lightshow-data');
  withEnv(t, { LIGHTSHOW_DATA_DIR: data });
  assert.equal(appDir(), ROOT);
  assert.equal(dataDir(), data);
  assert.equal(configDir(), path.join(data, 'config'));
  assert.equal(cacheDir(), path.join(data, 'cache'));
  assert.equal(logDir(), path.join(data, 'logs'));
  assert.equal(venvDir(), path.join(data, '.venv'));
});

test('each part named on its own wins over the data directory', (t) => {
  withEnv(t, {
    LIGHTSHOW_DATA_DIR: path.resolve('/srv/data'),
    LIGHTSHOW_CONFIG_DIR: path.resolve('/etc/show'),
    LIGHTSHOW_CACHE_DIR: path.resolve('/mnt/big/cache'),
    LIGHTSHOW_LOG_DIR: path.resolve('/var/log/show'),
  });
  assert.equal(configDir(), path.resolve('/etc/show'));
  assert.equal(cacheDir(), path.resolve('/mnt/big/cache'));
  assert.equal(logDir(), path.resolve('/var/log/show'));
  assert.equal(venvDir(), path.join(path.resolve('/srv/data'), '.venv'));
});

test('a blank setting is no setting', (t) => {
  withEnv(t, { LIGHTSHOW_DATA_DIR: '  ', LIGHTSHOW_CONFIG_DIR: '' });
  assert.equal(dataDir(), ROOT);
  assert.equal(configDir(), path.join(ROOT, 'config'));
});

test('the interpreter inside an environment, per platform', () => {
  assert.equal(venvPython('/x/.venv', 'linux'), path.join('/x/.venv', 'bin', 'python'));
  assert.equal(venvPython('/x/.venv', 'darwin'), path.join('/x/.venv', 'bin', 'python'));
  assert.equal(venvPython('C:/x/.venv', 'win32'), path.join('C:/x/.venv', 'Scripts', 'python.exe'));
});
