/**
 * Client-side token bootstrap. Loaded before the app on every page.
 *
 * The server requires a shared token whenever it is bound to anything but
 * loopback. Flow:
 *
 *   1. Operator opens  http://host:3000/?token=XYZ  once per browser, or types
 *      the token into the prompt this module raises when the server refuses.
 *   2. We stash the token and strip it from the URL so it does not linger in
 *      the address bar, history or any copied link.
 *   3. Every later /api call carries it as an X-Lightshow-Token header, and
 *      the Socket.IO handshake carries it as auth.token.
 *
 * The prompt matters because the lockout is easy to walk into: set a token in
 * the settings page, restart, and the very browser that set it has nothing
 * stored. Before, that browser showed a veil promising it was reconnecting —
 * while Socket.IO, which does not retry a handshake the server rejected, sat
 * there doing nothing. Now it asks for the token and reconnects on the spot.
 *
 * When no token is configured server-side this is inert: nothing is stored and
 * requests go out unchanged.
 */
(function () {
  'use strict';

  const KEY = 'lightshow.token';
  let token = '';

  // Pages register how to retry their own connection; a token typed into the
  // prompt has to reach the socket that was refused.
  const retriers = [];

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

  // Attach the header centrally rather than at ~13 call sites, so a new fetch
  // added later is authenticated without anyone having to remember. Installed
  // unconditionally, and reading `token` at call time, so a token typed into
  // the prompt applies to requests already written against window.fetch.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    if (!token) return nativeFetch(input, init);

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

  // ── The prompt ─────────────────────────────────────────────────────────────
  // Plain DOM on purpose: both the Preact control surface and the vanilla
  // settings page raise it, and the token is this module's business. It reuses
  // the .offline-veil / .offline-card styles both pages already load.

  let veil = null;
  let field = null;
  let note = null;

  function dismiss() {
    if (!veil) return;
    veil.remove();
    veil = null;
    field = null;
    note = null;
  }

  function submit(event) {
    event.preventDefault();
    const value = (field.value || '').trim();
    if (!value) return;

    token = value;
    window.LIGHTSHOW_TOKEN = value;
    try { localStorage.setItem(KEY, value); } catch (_) { /* private mode */ }

    note.textContent = 'Connecting…';
    field.blur();
    for (const retry of retriers) {
      try { retry(value); } catch (_) { /* one page's socket must not stop the rest */ }
    }
  }

  function build(message) {
    veil = document.createElement('div');
    veil.className = 'offline-veil';
    veil.setAttribute('role', 'alert');
    veil.innerHTML = `
      <div class="offline-card">
        <div class="offline-title">Access token required</div>
        <p class="offline-body">
          The server refused this browser. It is protected by an access token
          and this browser has not been given one — nothing you press here
          reaches the rig until it is.
        </p>
        <form class="token-form">
          <input type="password" class="token-input" placeholder="Access token"
                 autocomplete="off" spellcheck="false" aria-label="Access token" />
          <button type="submit" class="token-submit">Connect</button>
        </form>
        <p class="offline-body dim token-note"></p>
      </div>`;

    field = veil.querySelector('.token-input');
    note = veil.querySelector('.token-note');
    note.textContent = message;
    veil.querySelector('.token-form').addEventListener('submit', submit);
    document.body.appendChild(veil);
    field.focus();
  }

  // Where the token lives, said once rather than left to memory: the operator
  // reading this is locked out of the settings page too.
  const WHERE = 'Find it in config/settings.json under "server.token", or in the '
    + 'settings page on a browser that is still connected.';

  /**
   * Ask for the token. Safe to call repeatedly: a second call while the prompt
   * is up means the token just typed was refused, and says so instead of
   * stacking another prompt.
   */
  function requireToken() {
    if (veil) {
      note.textContent = 'That token was refused. ' + WHERE;
      if (field) { field.select(); field.focus(); }
      return;
    }
    build(WHERE);
  }

  window.LightshowAuth = {
    get token() { return token; },
    /** Called by a page when its connection comes up, to clear the prompt. */
    connected: dismiss,
    requireToken,
    /** Register how to retry a connection once a token has been entered. */
    onToken(retry) { retriers.push(retry); },
  };
})();
