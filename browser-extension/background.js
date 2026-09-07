// Background event page (Manifest V3).
//
// Receives snapshots from the content script and POSTs them to the lightshow
// server. Doing the fetch here means the request is NOT subject to page CORS —
// which is why the server carries no Access-Control-Allow-Origin header for
// these endpoints.
//
// MV3 note: under Manifest V3 this is a non-persistent *event page* (Firefox
// uses event pages here, not the service worker Chrome requires). Two things
// follow, and both are load-bearing:
//
//   1. The onMessage listener must be registered synchronously at top level, so
//      the browser knows to wake this page when a message arrives. It cannot be
//      registered inside a callback or after an await.
//   2. The page can be torn down as soon as it goes idle. A fire-and-forget
//      fetch() may therefore be killed mid-flight. Returning the fetch promise
//      from the listener keeps the page alive until the request settles.
'use strict';

const DEFAULT_SERVER = 'http://localhost:3000';

// Read on every message rather than cached: an event page can be unloaded at
// any point, so a module-level cache buys nothing and can only go stale.
async function settings() {
  const { server, token } = await browser.storage.local.get(['server', 'token']);
  return {
    server: (server || DEFAULT_SERVER).replace(/\/+$/, ''),
    token: token || '',
  };
}

async function post(msg) {
  const { server, token } = await settings();
  const url = msg.__disconnect ? `${server}/api/deezer/disconnect` : `${server}/api/deezer/state`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Lightshow-Token'] = token;

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: msg.__disconnect ? undefined : JSON.stringify(msg),
    });
  } catch (_) {
    // Server not running, wrong port, or wrong token — nothing useful to do
    // from here, and throwing would only produce console noise once a second.
  }
}

// Registered at top level: this is what lets the browser wake the event page.
// Returning the promise keeps the page alive until the POST settles.
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  return post(msg);
});
