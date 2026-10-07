import { computed, signal } from '@preact/signals';
import { io } from 'socket.io-client';
import { createVoiceHolds } from './hold-control.js';
import { timelinePosition } from './timeline-state.js';
import { createStore } from './store.js';
import { decodeDmxFrame } from '../src/shared/dmx-frame.ts';

// One signal per state key (store.js, protocol v2), so a field re-renders only its readers.
export const store = createStore();
export const field = store.field;
export const stateSig = store.all;

/** Reads the named keys, so the caller re-renders on those alone. */
export function pick(keys) {
  const out = {};
  for (const key of keys) out[key] = field(key).value;
  return out;
}
export const connectedSig = signal(false);

// 'unauthorized' apart from 'reconnecting': a refused handshake is never retried; auth.js asks for the token.
export const connectionSig = signal({ status: 'connecting' });

// Its own signal, so 30 frames a second wake only the DMX views that subscribed (wantDmx).
export const dmxSig = signal({});

// Changes only when the rig does, so the monitor lays out once rather than every frame.
export const dmxShapeSig = computed(() => {
  const snap = dmxSig.value || {};
  return Object.keys(snap).map(Number).sort((a, b) => a - b)
    .map((u) => `${u}:${(snap[u] || []).length}`).join(',');
});

// Pushed at ~10 Hz, on its own signal so only the timeline re-renders.
export const autoPositionSig = signal({ positionMs: 0, running: false, updatedAt: 0 });

export const autoTimelineSig = signal({ data: null, key: null, status: 'idle', error: null });

// Shared by the stage preview in both views so they never disagree; a drag stays in the component.
export const stagePreviewSig = signal({
  edit: false, rehearsal: false, playing: false, position: 0,
  // So a remount on a view switch is not taken for a new track.
  trackId: undefined,
});

// From public/auth.js, loaded first; guarded in case it is not.
const auth = (typeof window !== 'undefined' && window.LightshowAuth) || {
  token: '', connected: () => {}, requireToken: () => {}, onToken: () => {},
};

export const socket = io({
  transports: ['websocket', 'polling'],
  auth: { token: auth.token || '', protocol: 2 },
});

// Before the socket listeners, so a fast disconnect at startup cannot hit the TDZ.
export const voiceHolds = createVoiceHolds((payload) => emitLive('voice-hold', payload));

// Tells "not up yet" from "lost it"; connectionSig is already 'reconnecting' when retries fail.
let everOnline = false;

socket.on('connect', () => {
  everOnline = true;
  connectedSig.value = true;
  connectionSig.value = { status: 'online' };
  auth.connected();                       // clears the token prompt, if it was up
  loadLibrary();
});

socket.on('disconnect', () => {
  voiceHolds.releaseAll();
  freezePosition();
  connectedSig.value = false;
  connectionSig.value = { status: 'reconnecting' };
});

// socket.active: still retrying (server or network down); false: the token was refused.
socket.on('connect_error', () => {
  connectedSig.value = false;
  if (socket.active) {
    connectionSig.value = { status: everOnline ? 'reconnecting' : 'connecting' };
    return;
  }
  connectionSig.value = { status: 'unauthorized' };
  auth.requireToken();
});

// Retry with whatever the operator typed into that prompt.
auth.onToken((token) => {
  socket.auth = { token, protocol: 2 };
  connectionSig.value = { status: 'connecting' };
  socket.connect();
});

// The whole state on connect, and again whenever a patch shows one was missed.
socket.on('snapshot', (snapshot) => {
  if (!snapshot || !snapshot.state) return;
  store.applySnapshot(snapshot);
  if (snapshot.state.autoShow && !snapshot.state.autoShow.running) freezePosition();
});

// A patch out of sequence means one went missing: resync rather than drift.
let resyncing = false;
socket.on('patch', (patch) => {
  if (!patch) return;
  const result = store.applyPatch(patch);
  if (result === 'gap' && !resyncing) {
    resyncing = true;
    socket.emit('sync', (snapshot) => {
      resyncing = false;
      if (snapshot && snapshot.state) store.applySnapshot(snapshot);
      // A library change may be among what was missed.
      loadLibrary();
    });
    return;
  }
  if (result === 'ok' && patch.set && patch.set.autoShow && !patch.set.autoShow.running) freezePosition();
  if (result === 'ok' && patch.d === 'library') loadLibrary();
});

// DMX as bytes (src/shared/dmx-frame.ts), while subscribed.
socket.on('dmx-frame', (message) => {
  const frame = decodeDmxFrame(message);
  if (frame) dmxSig.value = frame;
});

// The first view subscribes, the last unsubscribes, and a reconnect subscribes again.
let dmxWanted = 0;
export function wantDmx() {
  if (dmxWanted++ === 0 && socket.connected) socket.emit('subscribe', ['dmx']);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--dmxWanted === 0 && socket.connected) socket.emit('unsubscribe', ['dmx']);
  };
}
socket.on('connect', () => { if (dmxWanted > 0) socket.emit('subscribe', ['dmx']); });

// About 30 a second to subscribers only, counted like the DMX feed; null while nobody listens.
export const audioFeedSig = signal(null);
socket.on('audio', (feed) => { audioFeedSig.value = feed; });
let audioWanted = 0;
export function wantAudio() {
  if (audioWanted++ === 0 && socket.connected) socket.emit('subscribe', ['audio']);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--audioWanted === 0) {
      if (socket.connected) socket.emit('unsubscribe', ['audio']);
      audioFeedSig.value = null;
    }
  };
}
socket.on('connect', () => { if (audioWanted > 0) socket.emit('subscribe', ['audio']); });
socket.on('auto-position', ({ positionMs, running, advancing, revision }) => {
  if (!Number.isFinite(positionMs)) return;
  const currentRevision = stateSig.value.autoShow?.timelineRevision;
  if (revision != null && currentRevision != null && revision !== currentRevision) return;
  autoPositionSig.value = { positionMs, running: !!running, advancing, revision, updatedAt: performance.now() };
});

// From public/toast.js, loaded first; guarded in case it is not.
const toast = (typeof window !== 'undefined' && window.Toast) || {
  error: () => {}, info: () => {}, success: () => {}, push: () => () => {},
};
export { toast };

// Socket refusals reach the operator; the messages are written for a person, so shown as-is.
socket.on('error-msg', ({ source, message, token }) => {
  // A refused hold must not stay lit and renewing.
  if (source === 'voice-hold') voiceHolds.refuse(token);
  if (message) toast.error(message);
});

// Toasts every failure, since most callers fire and forget; returns the parsed body either way.
export async function api(path, init) {
  try {
    const res = await fetch(path, {
      ...init,
      ...(init && init.body ? { headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      // Work the operator called off, or a newer track overtook, is not a failure.
      if (!body.cancelled) toast.error(body.error || `${init && init.method ? init.method : 'GET'} ${path} failed (${res.status})`);
      return { ok: false, error: body.error || `HTTP ${res.status}`, ...body };
    }
    return { ok: true, ...body };
  } catch (err) {
    // Almost always the server went away mid-show: say so rather than a bare TypeError.
    toast.error(`Could not reach the server: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// The live state has only summaries: specs come from GET /api/effects on connect and library changes.
export const librarySig = signal({ status: 'idle', families: [], builtin: [], user: [], palettes: { builtin: [], user: [] } });

let libraryLoads = 0;
export async function loadLibrary() {
  const load = ++libraryLoads;
  const res = await api('/api/effects');
  // Two loads in flight answer in either order; only the latest may land.
  if (load !== libraryLoads) return res;
  librarySig.value = res.ok
    ? { status: 'ready', families: res.families || [], builtin: res.builtin || [], user: res.user || [],
      palettes: { builtin: [], user: [], ...(res.palettes || {}) } }
    : { ...librarySig.value, status: 'error' };
  return res;
}

/** Change the library on this page the moment a save answers, ahead of the broadcast. */
export function patchLibrary(fn) {
  librarySig.value = fn(librarySig.value);
}

// Live actions must never queue up for replay after reconnecting.
export function emitLive(event, payload) {
  if (!socket.connected) return false;
  socket.emit(event, payload);
  return true;
}

export function send(patch) { return emitLive('set', patch); }
export function emitOverride(id, override) { return emitLive('override', { id, override }); }
export function emitFixture(payload) { return emitLive('fixture', payload); }
export function emitTap() { return emitLive('tap'); }
export function followMusic() { return api('/api/tempo/auto', { method: 'POST' }); }

function freezePosition() {
  const ap = autoPositionSig.value;
  if (!ap.running) return;
  const now = performance.now();
  autoPositionSig.value = { ...ap, positionMs: timelinePosition(ap, now), running: false, advancing: false, updatedAt: now };
}
