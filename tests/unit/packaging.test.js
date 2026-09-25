// The packaged build's own behaviour: where its launcher keeps the data
// (scripts/sea-main.cjs), and opening the app in the browser on its first
// start (src/server/open-browser.ts). The package itself is built and run by
// scripts/package.js and scripts/smoke-package.js, in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { openBrowser, shouldOpenBrowser } from '../../src/server/open-browser.ts';

const { dataDirFor } = createRequire(import.meta.url)('../../scripts/sea-main.cjs');

test('unzipped with its portable file, the data stays beside the app', () => {
  const exists = (f) => f === 'C:\\LS\\portable' || f === '/opt/ls/portable';
  assert.equal(dataDirFor({ root: 'C:\\LS', platform: 'win32', env: {}, home: 'C:\\Users\\op', exists }), 'C:\\LS\\data');
  assert.equal(dataDirFor({ root: '/opt/ls', platform: 'linux', env: {}, home: '/home/op', exists }), '/opt/ls/data');
});

test('installed, the data goes where the user\'s applications keep theirs', () => {
  const none = () => false;
  assert.equal(dataDirFor({ root: 'C:\\Programs\\LS', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' }, home: 'C:\\Users\\op', exists: none }),
    'C:\\Users\\op\\AppData\\Local\\ArtNet Lightshow');
  assert.equal(dataDirFor({ root: 'C:\\LS', platform: 'win32', env: {}, home: 'C:\\Users\\op', exists: none }),
    'C:\\Users\\op\\AppData\\Local\\ArtNet Lightshow', 'without LOCALAPPDATA, where it would be');
  assert.equal(dataDirFor({ root: '/opt/ls', platform: 'linux', env: {}, home: '/home/op', exists: none }), '/home/op/.local/share/artnet-lightshow');
  assert.equal(dataDirFor({ root: '/opt/ls', platform: 'linux', env: { XDG_DATA_HOME: '/data/op' }, home: '/home/op', exists: none }),
    '/data/op/artnet-lightshow');
  assert.equal(dataDirFor({ root: '/Applications/LS', platform: 'darwin', env: {}, home: '/Users/op', exists: none }),
    '/Users/op/Library/Application Support/ArtNet Lightshow');
});

test('LIGHTSHOW_DATA_DIR wins over both', () => {
  assert.equal(dataDirFor({ root: '/opt/ls', platform: 'linux', env: { LIGHTSHOW_DATA_DIR: '/srv/show' }, exists: () => true }), '/srv/show');
  assert.equal(dataDirFor({ root: '/opt/ls', platform: 'linux', env: { LIGHTSHOW_DATA_DIR: ' ' }, home: '/h', exists: () => true }),
    '/opt/ls/data', 'a blank one is none');
});

test('the browser opens on the packaged build\'s first start only, and not when told not to', () => {
  const packaged = { LIGHTSHOW_PACKAGED: '1' };
  assert.equal(shouldOpenBrowser({ env: packaged, argv: [], restarts: 0 }), true);
  assert.equal(shouldOpenBrowser({ env: packaged, argv: [], restarts: 1 }), false, 'not each time the supervisor starts it again');
  assert.equal(shouldOpenBrowser({ env: packaged, argv: ['--no-browser'], restarts: 0 }), false);
  assert.equal(shouldOpenBrowser({ env: { ...packaged, LIGHTSHOW_OPEN_BROWSER: '0' }, argv: [], restarts: 0 }), false);
  assert.equal(shouldOpenBrowser({ env: {}, argv: [], restarts: 0 }), false, 'never from a checkout');
});

test('the browser is opened by what each system opens URLs with, without waiting for it', () => {
  const calls = [];
  const spawner = (command, args, options) => {
    calls.push([command, args, options.detached, options.stdio]);
    const child = new EventEmitter();
    child.unref = () => calls.push('unref');
    return child;
  };
  const url = 'http://localhost:3000/?a=1&b=2';
  assert.equal(openBrowser(url, { platform: 'win32', spawner }), true);
  assert.equal(openBrowser(url, { platform: 'darwin', spawner }), true);
  assert.equal(openBrowser(url, { platform: 'linux', spawner }), true);
  assert.deepEqual(calls, [
    ['rundll32', ['url.dll,FileProtocolHandler', url], true, 'ignore'], 'unref',
    ['open', [url], true, 'ignore'], 'unref',
    ['xdg-open', [url], true, 'ignore'], 'unref',
  ]);
  assert.equal(openBrowser(url, { platform: 'linux', spawner: () => { throw new Error('ENOENT'); } }), false);
});
