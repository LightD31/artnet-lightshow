// Background worker. Receives snapshots from the content script and POSTs them
// to the local lightshow server. Doing the fetch here (with the host permission
// declared in manifest.json) means the request is NOT subject to page CORS.
(function () {
  'use strict';

  const SERVER = 'http://localhost:3000';

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    const url = msg.__disconnect ? `${SERVER}/api/deezer/disconnect` : `${SERVER}/api/deezer/state`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: msg.__disconnect ? undefined : JSON.stringify(msg),
    }).catch(() => { /* server not running — ignore */ });
  });
})();
