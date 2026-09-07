// Settings for the bridge: which lightshow server to post to, and the access
// token when the server requires one (see AUDIT.md C2). Stored in
// browser.storage.local and read by background.js on every send.
'use strict';

const DEFAULT_SERVER = 'http://localhost:3000';

const serverEl = document.getElementById('server');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

browser.storage.local.get(['server', 'token']).then(({ server, token }) => {
  serverEl.value = server || DEFAULT_SERVER;
  tokenEl.value = token || '';
});

function isLoopback(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch (_) {
    return false;
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const server = (serverEl.value || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  const token = tokenEl.value.trim();

  // The manifest only grants loopback host access. Pointing the bridge at a
  // server elsewhere on the network needs an explicit opt-in from the user,
  // requested here under the click gesture rather than baked into the manifest.
  if (!isLoopback(server)) {
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: ['http://*/*'] });
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      statusEl.style.color = '#b3261e';
      statusEl.textContent = 'Permission denied — not saved';
      return;
    }
  }

  await browser.storage.local.set({ server, token });
  statusEl.style.color = '#1a7f37';
  statusEl.textContent = 'Saved';
  setTimeout(() => { statusEl.textContent = ''; }, 1500);
});
