// socket.io-client for component tests: a socket that is never connected and
// remembers what it was sent, so public-src/state.js loads in Node.

export function io() {
  const handlers = new Map();
  return {
    connected: false,
    active: false,
    auth: {},
    sent: [],
    on(event, fn) { handlers.set(event, fn); return this; },
    emit(...args) { this.sent.push(args); return this; },
    connect() { return this; },
  };
}
