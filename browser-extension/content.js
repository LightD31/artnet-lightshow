// Content script (isolated world). It can't read window.dzPlayer directly, so
// it injects inject.js into the page context and relays the snapshots that
// script postMessage()s back, forwarding them to the background worker (which
// does the cross-origin POST to the lightshow server).
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
