import { signal } from '@preact/signals';
import { io } from 'socket.io-client';

// Single source of truth on the client. Mirrors the server's getClientState()
// snapshot; components read from it via the signal.
export const stateSig = signal({});
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

// Live DMX values, on their own signal so the 10 Hz stream only re-renders the
// views that show DMX output (the monitor and the fixture previews) instead of
// waking every control panel in the tree.
export const dmxSig = signal({});

// Auto-show playback position (pushed from server at ~10 Hz). Held in its own
// signal so the timeline visualiser can re-render without churning the rest.
export const autoPositionSig = signal({ positionMs: 0, running: false, updatedAt: 0 });

// Auto-show timeline payload (loaded on demand from /api/auto/timeline).
export const autoTimelineSig = signal({ data: null, fetchedKey: null });

// Token comes from public/auth.js, which runs before this bundle. Guarded so the
// bundle still works if it ever loads without it.
const auth = (typeof window !== 'undefined' && window.LightshowAuth) || {
  token: '', connected: () => {}, requireToken: () => {}, onToken: () => {},
};

export const socket = io({
  transports: ['websocket', 'polling'],
  auth: { token: auth.token || '' },
});

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
  socket.auth = { token };
  connectionSig.value = { status: 'connecting' };
  socket.connect();
});

// MERGE, don't replace. The first push on connect is the full snapshot
// including the static catalogues (colour presets, patterns, strobe functions);
// every later push carries only the fields that change. Replacing would drop
// the catalogues on the first update after connect.
socket.on('state', (s) => {
  if (!s) return;
  if (s.dmxSnapshot) dmxSig.value = s.dmxSnapshot;   // full snapshot on connect
  stateSig.value = { ...stateSig.value, ...s };
});

socket.on('dmx', (snapshot) => { dmxSig.value = snapshot || {}; });
socket.on('auto-position', ({ positionMs, running }) => {
  autoPositionSig.value = { positionMs, running: !!running, updatedAt: performance.now() };
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
      toast.error(body.error || `${init && init.method ? init.method : 'GET'} ${path} failed (${res.status})`);
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

export function send(patch) { socket.emit('set', patch); }
export function emitOverride(id, override) { socket.emit('override', { id, override }); }
export function emitFixture(payload) { socket.emit('fixture', payload); }
export function emitTap() { socket.emit('tap'); }
