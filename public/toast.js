/**
 * Toasts — the app's one way of saying something went wrong, or offering to
 * take it back.
 *
 * Loaded before both bundles on both pages, because the live page (Preact) and
 * the settings page (plain DOM) both need this and there is no reason for the
 * operator to meet two different notification styles in one app.
 *
 * The server rejects input on six socket paths and every REST route answers
 * `{ ok: false, error }`, and until this existed none of it reached the
 * operator: a refused DMX address just snapped back on the next broadcast,
 * which reads as the app eating your input. Anything the server refuses should
 * say so, out loud, where you are looking.
 *
 *   Toast.push({ message, kind, action, timeout })
 *   Toast.error(message)
 *   Toast.info(message)
 *
 * `action` is `{ label, onClick }` and is how undo is offered.
 * Returns a function that dismisses the toast early.
 */
(function () {
  'use strict';

  const KIND_TIMEOUTS = {
    // Long enough to read and act on, short enough not to sit over the UI
    // during a show.
    error: 8000,
    info: 5000,
    success: 4000,
  };

  // An undo has to outlast the surprise of realising you need it.
  const ACTION_TIMEOUT = 12000;

  let host = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.className = 'toast-host';
    // Announced politely: a rejected address is worth hearing about, but not
    // worth interrupting whatever a screen reader is already saying.
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  function push({ message, kind = 'info', action = null, timeout } = {}) {
    if (!message) return () => {};

    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;

    const text = document.createElement('span');
    text.className = 'toast-message';
    // textContent, not innerHTML: these carry server error strings, which can
    // contain a fixture label the operator typed.
    text.textContent = String(message);
    node.appendChild(text);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      node.classList.add('leaving');
      // Let the transition finish, but never leave the node behind if the
      // browser skips it (reduced motion, background tab).
      setTimeout(() => node.remove(), 200);
    };

    if (action && action.label) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        dismiss();
        try {
          action.onClick();
        } catch (err) {
          push({ message: `Could not ${action.label.toLowerCase()}: ${err.message}`, kind: 'error' });
        }
      });
      node.appendChild(button);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', dismiss);
    node.appendChild(close);

    const ms = timeout != null
      ? timeout
      : (action ? ACTION_TIMEOUT : (KIND_TIMEOUTS[kind] || KIND_TIMEOUTS.info));
    const timer = ms > 0 ? setTimeout(dismiss, ms) : null;

    const container = ensureHost();
    container.appendChild(node);
    // Newest at the bottom, nearest the corner. A stuck stream of errors — a
    // controller spraying rejected messages, say — must not bury the page.
    while (container.children.length > 5) container.firstChild.remove();

    return dismiss;
  }

  window.Toast = {
    push,
    error: (message, extra) => push({ ...extra, message, kind: 'error' }),
    info: (message, extra) => push({ ...extra, message, kind: 'info' }),
    success: (message, extra) => push({ ...extra, message, kind: 'success' }),
  };
})();
