// One answer to "is this host this machine only?", for the access check, the
// settings that need a token, the pre-show report and Art-Net discovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopback } from '../../src/server/loopback.ts';

test('names, addresses and socket addresses of this machine are loopback', () => {
  for (const h of ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', ' localhost ',
    '::1', '[::1]', '::ffff:127.0.0.1', '::FFFF:127.0.0.9']) {
    assert.equal(isLoopback(h), true, h);
  }
});

test('anything that reaches past this machine is not', () => {
  for (const h of ['0.0.0.0', '::', '192.168.1.10', '2.255.255.255', '::ffff:192.168.1.10', '128.0.0.1',
    '127.0.0', 'localhost.example.com', 'node.local', '', null, undefined]) {
    assert.equal(isLoopback(h), false, String(h));
  }
});
