import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api, socket } from './state.js';


export const settingsSig = signal(null);
export const settingsErrorSig = signal(null);

export const at = (obj, dotted) => dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

let loading = null;

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

export async function saveSettings(patch) {
  const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  if (res.ok) {
    settingsSig.value = { ...(settingsSig.value || {}), ...res };
  }
  return res;
}

export function useSettings() {
  useEffect(() => { if (!settingsSig.value) loadSettings(); }, []);
  return settingsSig.value;
}

// Refetch after reconnect because a restart may have applied pending settings.
socket.on('connect', () => { if (settingsSig.value) loadSettings(); });


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

export const networkInterfaces = lister('/api/network/interfaces', (d) => d.interfaces || [], []);
export const liveDevices = lister('/api/live/devices', (d) => ({ outputs: d.outputs || [], inputs: d.inputs || [] }), { outputs: [], inputs: [] });

export const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body ?? {}) });

export function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
