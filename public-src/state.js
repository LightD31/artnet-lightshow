import { computed, signal } from '@preact/signals';
import { io } from 'socket.io-client';
import { createHoldControl } from './hold-control.js';
import { timelinePosition } from './timeline-state.js';
import { createStore } from './store.js';
import { decodeDmxFrame } from '../src/shared/dmx-frame.ts';

// Single source of truth on the client: the server's state, one signal per key
// (store.js, protocol v2 — src/server/protocol.ts). `field('masterDimmer')`
// re-renders only on that key; `stateSig` is everything at once, for the
// components that want it.
export const store = createStore();
export const field = store.field;
export const stateSig = store.all;

/**
 * The named keys of the state, read so that the calling component re-renders
 * when one of them changes and not for anything else.
 */
export function pick(keys) {
  const out = {};
  for (const key of keys) out[key] = field(key).value;
  return out;
}
export const connectedSig = signal(false);

// Why the surface is barred, not just that it is. Socket.IO retries a dropped
// connection on its own but gives up immediately on a handshake the server
// rejected, so "reconnecting" was a promise the page could not keep: a browser
// without the access token sat behind that veil forever while nothing retried.
//   connecting    — first attempt, has never been online
//   online        — live
//   reconnecting  — was online, socket dropped, Socket.IO is retrying
//   unauthorized  — handshake refused; public/auth.js is asking for the token
export const connectionSig = signal({ status: 'connecting' });

// Live DMX values by universe, on their own signal so the stream only
// re-renders the views that show DMX output (the monitor and the fixture
// previews) instead of waking every control panel in the tree. Thirty binary
// frames a second, and only while one of those views is on screen and has
// subscribed (useDmxFeed).
export const dmxSig = signal({});

// The *shape* of that stream — which universes are live and how many channels
// each carries — as a comparable string. It recomputes on every frame but its
// value changes only when the rig does, so a component reading this instead of
// dmxSig lays out the monitor once rather than ten times a second. The values
// themselves are written into the cells imperatively.
export const dmxShapeSig = computed(() => {
  const snap = dmxSig.value || {};
  return Object.keys(snap).map(Number).sort((a, b) => a - b)
    .map((u) => `${u}:${(snap[u] || []).length}`).join(',');
});

// Auto-show playback position (pushed from server at ~10 Hz). Held in its own
// signal so the timeline visualiser can re-render without churning the rest.
export const autoPositionSig = signal({ positionMs: 0, running: false, updatedAt: 0 });

// Auto-show timeline payload (loaded on demand from /api/auto/timeline).
export const autoTimelineSig = signal({ data: null, key: null, status: 'idle', error: null });

// Stage preview panel state. The panel is mounted in both the manual and the
// auto view, and two copies of this in component state meant an operator who
// started positioning fixtures in one view found the other still in live mode —
// or worse, rehearsing at a different position. It is one panel to the person
// using it, so it gets one piece of state.
//
// The drag in progress deliberately stays local to the component: it belongs to
// one pointer on one surface, and sharing it would let a drag begun in one view
// go on driving a lamp in the other.
export const stagePreviewSig = signal({
  edit: false, rehearsal: false, playing: false, position: 0,
  // The track the rehearsal belongs to (StagePreview), so a view switch that
  // remounts the panel does not mistake itself for a new track.
  trackId: undefined,
});

// Token comes from public/auth.js, which runs before this bundle. Guarded so the
// bundle still works if it ever loads without it.
const auth = (typeof window !== 'undefined' && window.LightshowAuth) || {
  token: '', connected: () => {}, requireToken: () => {}, onToken: () => {},
};

export const socket = io({
  transports: ['websocket', 'polling'],
  auth: { token: auth.token || '', protocol: 2 },
});

// Created before socket listeners are registered so a very fast disconnect
// during page startup cannot hit a temporal-dead-zone reference.
export const energyHold = createHoldControl((payload) => emitLive('energy-hold', payload));

// Whether this page has ever had a live socket, which is what separates "not up
// yet" from "we lost it". Kept apart from connectionSig, which is already
// 'reconnecting' by the time the retry errors arrive.
let everOnline = false;

socket.on('connect', () => {
  everOnline = true;
  connectedSig.value = true;
  connectionSig.value = { status: 'online' };
  auth.connected();                       // clears the token prompt, if it was up
});

socket.on('disconnect', () => {
  energyHold.release();
  freezePosition();
  connectedSig.value = false;
  connectionSig.value = { status: 'reconnecting' };
});

// A refused handshake and an unreachable server both land here. `socket.active`
// tells them apart: true means Socket.IO is still retrying (server down, network
// gone), false means it has given up because a middleware rejected us — which,
// on this server, only happens for a missing or wrong token.
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

// Then only what changed. A patch that is not the next for its domain means
// one went missing: ask for the whole state rather than drift.
let resyncing = false;
socket.on('patch', (patch) => {
  if (!patch) return;
  const result = store.applyPatch(patch);
  if (result === 'gap' && !resyncing) {
    resyncing = true;
    socket.emit('sync', (snapshot) => {
      resyncing = false;
      if (snapshot && snapshot.state) store.applySnapshot(snapshot);
    });
    return;
  }
  if (result === 'ok' && patch.set && patch.set.autoShow && !patch.set.autoShow.running) freezePosition();
});

// DMX as bytes (src/shared/dmx-frame.ts), while subscribed.
socket.on('dmx-frame', (message) => {
  const frame = decodeDmxFrame(message);
  if (frame) dmxSig.value = frame;
});

// How many views on screen want the DMX feed. The first subscribes, the last
// unsubscribes, and a reconnect subscribes again for whoever is still there.
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
socket.on('auto-position', ({ positionMs, running, advancing, revision }) => {
  if (!Number.isFinite(positionMs)) return;
  const currentRevision = stateSig.value.autoShow?.timelineRevision;
  if (revision != null && currentRevision != null && revision !== currentRevision) return;
  autoPositionSig.value = { positionMs, running: !!running, advancing, revision, updatedAt: performance.now() };
});

// Toast comes from public/toast.js, which runs before this bundle. Guarded so
// the bundle still works if it ever loads without it.
const toast = (typeof window !== 'undefined' && window.Toast) || {
  error: () => {}, info: () => {}, success: () => {}, push: () => () => {},
};
export { toast };

// The server refuses invalid input on every socket path — an address past the
// end of a universe, a fixture move over the transmit cap, a bad MIDI port.
// Until this listener existed none of it reached the operator: the control just
// snapped back on the next broadcast, which reads as the app eating your input.
//
// The messages are written for a person (they name the fixture and say what the
// limit is), so they go out as-is.
socket.on('error-msg', ({ message }) => {
  if (message) toast.error(message);
});

/**
 * Fetch a JSON API and surface the failure.
 *
 * Nearly every call site was fire-and-forget, so a 400 from the server looked
 * exactly like success. Returns the parsed body either way; callers that want
 * to branch still can, and callers that don't at least stop swallowing errors.
 */
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
    // A network-level failure here almost always means the server went away
    // mid-show, which is worth saying plainly rather than as a bare TypeError.
    toast.error(`Could not reach the server: ${err.message}`);
    return { ok: false, error: err.message };
  }
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

function freezePosition() {
  const ap = autoPositionSig.value;
  if (!ap.running) return;
  const now = performance.now();
  autoPositionSig.value = { ...ap, positionMs: timelinePosition(ap, now), running: false, advancing: false, updatedAt: now };
}
