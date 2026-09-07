/**
 * Client-side token bootstrap. Loaded before the app on every page.
 *
 * The server requires a shared token whenever it is bound to anything but
 * loopback (see AUDIT.md C2). Flow:
 *
 *   1. Operator opens  http://host:3000/?token=XYZ  once per browser.
 *   2. We stash the token and strip it from the URL so it does not linger in
 *      the address bar, history or any copied link.
 *   3. Every later /api call carries it as an X-Lightshow-Token header, and
 *      the Socket.IO handshake carries it as auth.token.
 *
 * When no token is configured server-side this is inert: nothing is stored and
 * requests go out unchanged.
 */
(function () {
  'use strict';

  const KEY = 'lightshow.token';
  let token = '';

  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      try { localStorage.setItem(KEY, fromUrl); } catch (_) { /* private mode */ }
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    token = fromUrl || localStorage.getItem(KEY) || '';
  } catch (_) {
    token = '';
  }

  // Read by state.js / settings.js when opening the socket.
  window.LIGHTSHOW_TOKEN = token;

  if (!token) return;

  // Attach the header centrally rather than at ~13 call sites, so a new fetch
  // added later is authenticated without anyone having to remember.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    const target = typeof input === 'string' ? input : (input && input.url) || '';
    // Only same-origin API traffic — never leak the token to a third party.
    const isApi = target.indexOf('/api') === 0
      || target.indexOf(window.location.origin + '/api') === 0;
    if (!isApi) return nativeFetch(input, init);

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Lightshow-Token', token);
    const next = {};
    for (const k in init) if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k];
    next.headers = headers;
    return nativeFetch(input, next);
  };
})();
