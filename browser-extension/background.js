// Background worker. Receives snapshots from the content script and POSTs them
// to the lightshow server. Doing the fetch here (with the host permission
// declared in manifest.json) means the request is NOT subject to page CORS —
// which is why the server carries no Access-Control-Allow-Origin header for
// these endpoints (see AUDIT.md H2).
(function () {
  'use strict';

  const DEFAULT_SERVER = 'http://localhost:3000';

  // Server URL and token are configurable in the extension's preferences, so a
  // non-default PORT or a token-protected server both work without editing this
  // file (see AUDIT.md C2, L11).
  function settings() {
    return browser.storage.local.get(['server', 'token']).then(({ server, token }) => ({
      server: (server || DEFAULT_SERVER).replace(/\/+$/, ''),
      token: token || '',
    }));
  }

  browser.runtime.onMessage.addListener(async (msg) => {
    if (!msg) return;
    const { server, token } = await settings();
    const url = msg.__disconnect ? `${server}/api/deezer/disconnect` : `${server}/api/deezer/state`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Lightshow-Token'] = token;

    fetch(url, {
      method: 'POST',
      headers,
      body: msg.__disconnect ? undefined : JSON.stringify(msg),
    }).catch(() => { /* server not running — ignore */ });
  });
})();
