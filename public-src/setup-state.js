import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api, socket } from './state.js';

/**
 * The setup views' share of the server: the stored settings (settings.json,
 * secrets redacted) and the lists the forms pick from.
 *
 * The live state (the patch, the profiles, MIDI's ports) arrives over the
 * socket like everything else; these do not, because they change only when
 * someone saves — so they are fetched when a setup view first needs them, and
 * again after a save or a reconnect.
 */

// { settings, secrets, restartKeys, pendingRestart, python, running, engine,
//   configFile } from GET /api/settings; null until loaded.
export const settingsSig = signal(null);
export const settingsErrorSig = signal(null);

/** The value at a dotted path: at(settings, 'artnet.host'). */
export const at = (obj, dotted) => dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

let loading = null;

/** Fetch the settings (once at a time); the signal holds them after. */
export function loadSettings() {
  if (loading) return loading;
  loading = fetch('/api/settings')
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.error || 'The server did not send its settings');
      settingsSig.value = data;
      settingsErrorSig.value = null;
      return data;
    })
    .catch((err) => {
      settingsErrorSig.value = err.message;
      return null;
    })
    .finally(() => { loading = null; });
  return loading;
}

/**
 * Save a patch of settings (`{ group: { key: value } }`). The reply is the
 * whole redacted set again and what now needs a restart, merged in so every
 * section shows the saved values. Answers `{ ok, error, pendingRestart }`.
 */
export async function saveSettings(patch) {
  const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  if (res.ok) {
    settingsSig.value = { ...(settingsSig.value || {}), ...res };
  }
  return res;
}

/** Load the settings when a view that shows them first appears. */
export function useSettings() {
  useEffect(() => { if (!settingsSig.value) loadSettings(); }, []);
  return settingsSig.value;
}

// A reconnect may follow a restart that applied pending settings, so what is
// shown is read again rather than trusted.
socket.on('connect', () => { if (settingsSig.value) loadSettings(); });

// ── Lists the forms pick from ───────────────────────────────────────────────

/** GET a JSON list once per page, kept in a signal; `refresh` asks again. */
function lister(path, pick, empty) {
  const sig = signal(empty);
  let asked = false;
  const refresh = async () => {
    asked = true;
    try {
      const data = await (await fetch(path)).json();
      if (data.ok) sig.value = pick(data);
    } catch { /* the form still offers its default */ }
  };
  const use = () => {
    useEffect(() => { if (!asked) refresh(); }, []);
    return sig.value;
  };
  return { sig, refresh, use };
}

// This machine's IPv4 addresses, for the sACN network.
export const networkInterfaces = lister('/api/network/interfaces', (d) => d.interfaces || [], []);
// The audio devices the live input can hear.
export const liveDevices = lister('/api/live/devices', (d) => ({ outputs: d.outputs || [], inputs: d.inputs || [] }), { outputs: [], inputs: [] });

/** POST or PUT JSON and surface a refusal: `api` with the body encoded. */
export const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body ?? {}) });

/** A profile id from free text, as the server's own ids are made. */
export function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
