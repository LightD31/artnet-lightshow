import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createAuth } from '../../src/server/auth.ts';

for (const transport of ['polling', 'websocket']) {
  test(`SSO proxy credential connects ${transport} without a browser token`, async (t) => {
    const server = createServer();
    const auth = createAuth({ token: 'test-server-secret' });
    const io = new Server(server, { allowRequest: auth.allowSocketRequest });
    io.use(auth.socketMiddleware);
    t.after(() => new Promise((resolve) => io.close(resolve)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `127.0.0.1:${server.address().port}`;
    const attempt = (headers) => new Promise((resolve) => {
      const socket = connect(`http://${address}`, {
        transports: [transport], extraHeaders: headers, reconnection: false,
        timeout: 2000, forceNew: true,
      });
      t.after(() => socket.close());
      socket.once('connect', () => { socket.close(); resolve(null); });
      socket.once('connect_error', resolve);
    });
    assert.equal(await attempt({ 'X-Lightshow-Token': 'test-server-secret', Origin: `http://${address}` }), null);
    assert.ok(await attempt({}));
    assert.ok(await attempt({ 'X-Lightshow-Token': 'wrong' }));
    assert.ok(await attempt({ 'X-Lightshow-Token': 'test-server-secret', Origin: 'https://evil.example' }));
  });
}
