// Content script (isolated world). It can't read window.dzPlayer directly, so
// it injects inject.js into the page context and relays the snapshots that
// script postMessage()s back, forwarding them to the background event page
// (which does the cross-origin POST to the lightshow server).
//
// inject.js is reachable because manifest.json lists it under
// web_accessible_resources — in MV3 that entry is an object with an explicit
// `matches` list, not a bare filename as it was under MV2.
(function () {
  'use strict';

  const el = document.createElement('script');
  el.src = browser.runtime.getURL('inject.js');
  el.onload = () => el.remove();
  (document.head || document.documentElement).appendChild(el);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lsBridge !== 'deezer') return;
    browser.runtime.sendMessage(e.data.payload).catch(() => {});
  });

  // Drop Deezer as a source when the tab is closed or navigated away.
  window.addEventListener('pagehide', () => {
    browser.runtime.sendMessage({ __disconnect: true }).catch(() => {});
  });
})();
