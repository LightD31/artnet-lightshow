// Since 2025.11.12 yt-dlp needs a JavaScript runtime for YouTube. The server
// hands it its own Node — but only to a version that knows the option, since
// an older one refuses to run at all with an unknown flag.

import test from 'node:test';
import assert from 'node:assert';
import * as ytdlp from '../../src/ytdlp.ts';

test('versions are compared as dates', () => {
  assert.ok(ytdlp.dateOf('2025.11.12') > ytdlp.dateOf('2025.9.26'));
  assert.ok(ytdlp.dateOf('2026.01.03') > ytdlp.dateOf('2025.12.31'));
  assert.strictEqual(ytdlp.dateOf('nightly'), 0);
});

test('only a yt-dlp that understands --js-runtimes is given one', () => {
  assert.deepStrictEqual(ytdlp.runtimeArgs('2025.11.12', '/usr/bin/node'), ['--js-runtimes', 'node:/usr/bin/node']);
  assert.deepStrictEqual(ytdlp.runtimeArgs('2026.03.01.232512', '/usr/bin/node'), ['--js-runtimes', 'node:/usr/bin/node']);
  assert.deepStrictEqual(ytdlp.runtimeArgs('2025.10.22'), []);
  assert.deepStrictEqual(ytdlp.runtimeArgs(null), [], 'unknown version: pass nothing rather than break the run');
});

test('the runtime handed over is the Node running this server', () => {
  const [, value] = ytdlp.runtimeArgs('2025.11.12');
  assert.strictEqual(value, `node:${process.execPath}`);
});
